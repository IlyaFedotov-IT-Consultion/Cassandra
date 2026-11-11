import { randomUUID } from "node:crypto";

import {
  CalibrationSnapshotSchema,
  OutcomeInputSchema,
  VerdictTraceSchema,
  type CalibrationSnapshot,
  type CalibrationSnapshotSummary,
  type OutcomeInput,
  type VerdictTrace,
} from "@cassandra/shared";
import type { Pool } from "pg";

const DEFAULT_JUDGE_WEIGHTS = {
  official_records: 1 / 3,
  community_signal: 1 / 3,
  open_web_research: 1 / 3,
};

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapCalibrationSnapshotRow(row: Record<string, unknown>): CalibrationSnapshot {
  return {
    id: String(row.id),
    createdAt: toIsoString(row.created_at),
    trainingWindow: String(row.training_window),
    judgeWeights:
      row.judge_weights && typeof row.judge_weights === "object"
        ? (row.judge_weights as Record<string, unknown>)
        : {},
    baseRateParams:
      row.base_rate_params && typeof row.base_rate_params === "object"
        ? (row.base_rate_params as Record<string, unknown>)
        : {},
    marketPriorParams:
      row.market_prior_params && typeof row.market_prior_params === "object"
        ? (row.market_prior_params as Record<string, unknown>)
        : {},
    calibrationParams:
      row.calibration_params && typeof row.calibration_params === "object"
        ? (row.calibration_params as Record<string, unknown>)
        : {},
    onlineLearningParams:
      row.online_learning_params && typeof row.online_learning_params === "object"
        ? (row.online_learning_params as Record<string, unknown>)
        : {},
    metrics:
      row.metrics && typeof row.metrics === "object"
        ? (row.metrics as Record<string, unknown>)
        : {},
    weightRegime: row.weight_regime as CalibrationSnapshot["weightRegime"],
    resolvedOutcomeCount: Number(row.resolved_outcome_count),
    approved: Boolean(row.approved),
  };
}

export function selectWeightRegime(
  resolvedOutcomeCount: number,
): CalibrationSnapshot["weightRegime"] {
  if (resolvedOutcomeCount >= 100) {
    return "steady";
  }

  if (resolvedOutcomeCount >= 20) {
    return "warming";
  }

  return "cold_start";
}

export async function createCalibrationSnapshot(
  pool: Pool,
  snapshot: Omit<CalibrationSnapshot, "id" | "createdAt">,
): Promise<CalibrationSnapshot> {
  const result = await pool.query(
    `
      INSERT INTO calibration_snapshots (
        id,
        training_window,
        judge_weights,
        base_rate_params,
        market_prior_params,
        calibration_params,
        online_learning_params,
        metrics,
        weight_regime,
        resolved_outcome_count,
        approved
      )
      VALUES (
        $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb,
        $7::jsonb, $8::jsonb, $9, $10, $11
      )
      RETURNING *
    `,
    [
      randomUUID(),
      snapshot.trainingWindow,
      JSON.stringify(snapshot.judgeWeights),
      JSON.stringify(snapshot.baseRateParams),
      JSON.stringify(snapshot.marketPriorParams),
      JSON.stringify(snapshot.calibrationParams),
      JSON.stringify(snapshot.onlineLearningParams),
      JSON.stringify(snapshot.metrics),
      snapshot.weightRegime,
      snapshot.resolvedOutcomeCount,
      snapshot.approved,
    ],
  );

  return mapCalibrationSnapshotRow(result.rows[0] as Record<string, unknown>);
}

export const BASELINE_CALIBRATION_SNAPSHOT_ID = "baseline-identity";

/**
 * What judgments run on until an operator approves a snapshot: no calibration map, uniform
 * judge weights, no learned base rates and market prices trusted as priced.
 */
export function baselineCalibrationSnapshot(): CalibrationSnapshot {
  return {
    id: BASELINE_CALIBRATION_SNAPSHOT_ID,
    createdAt: new Date(0).toISOString(),
    trainingWindow: "none",
    judgeWeights: {},
    baseRateParams: {},
    marketPriorParams: {},
    calibrationParams: { method: "identity" },
    onlineLearningParams: { enabled: false },
    metrics: {},
    weightRegime: "cold_start",
    resolvedOutcomeCount: 0,
    approved: false,
  };
}

/**
 * The snapshot judgments use: the newest approved one. Nothing learned takes effect until
 * someone has approved it, so without an approved snapshot this is the identity baseline.
 */
export async function getActiveCalibrationSnapshot(pool: Pool): Promise<CalibrationSnapshot> {
  const result = await pool.query(`
    SELECT *
    FROM calibration_snapshots
    WHERE approved = TRUE
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (result.rowCount === 0) {
    return baselineCalibrationSnapshot();
  }

  return mapCalibrationSnapshotRow(result.rows[0] as Record<string, unknown>);
}

export async function getCalibrationSnapshotById(
  pool: Pool,
  snapshotId: string,
): Promise<CalibrationSnapshot | null> {
  const result = await pool.query(`SELECT * FROM calibration_snapshots WHERE id = $1`, [
    snapshotId,
  ]);

  if (result.rowCount === 0) {
    return null;
  }

  return mapCalibrationSnapshotRow(result.rows[0] as Record<string, unknown>);
}

export async function listCalibrationSnapshots(pool: Pool): Promise<CalibrationSnapshotSummary[]> {
  const result = await pool.query(`
    SELECT id, created_at, training_window, metrics, weight_regime, resolved_outcome_count, approved
    FROM calibration_snapshots
    ORDER BY approved DESC, created_at DESC
  `);

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      createdAt: toIsoString(r.created_at),
      trainingWindow: String(r.training_window),
      metrics:
        r.metrics && typeof r.metrics === "object"
          ? (r.metrics as Record<string, unknown>)
          : {},
      weightRegime: r.weight_regime as CalibrationSnapshotSummary["weightRegime"],
      resolvedOutcomeCount: Number(r.resolved_outcome_count),
      approved: Boolean(r.approved),
    };
  });
}

export interface MarketPricePair {
  groupId?: string;
  price: number;
  outcome: boolean;
}

/** A replayed benchmark forecast, in the shape the judge service trains calibration on. */
export interface ForecastPair {
  /** The benchmark market: its forecasts at several horizons are not independent. */
  groupId: string;
  /** The forecast before any calibration map was applied. */
  probability: number;
  outcome: boolean;
  priorProbability: number | null;
  judgeOpinions: Array<{ judgeName: string; logBayesFactor: number; hadEvidence: boolean }>;
}

export async function loadCalibrationTrainingData(
  pool: Pool,
): Promise<{
  historicalTraces: VerdictTrace[];
  resolvedOutcomes: OutcomeInput[];
  marketPricePairs: MarketPricePair[];
  forecastPairs: ForecastPair[];
}> {
  // One outcome per event: the most recently recorded one wins (corrections supersede).
  const outcomesResult = await pool.query(`
    SELECT DISTINCT ON (event_id)
      event_id,
      resolved_value,
      resolved_at,
      resolution_source_url
    FROM outcomes
    ORDER BY event_id, created_at DESC
  `);

  // Per resolved event, the latest judgment evaluated strictly before the event resolved,
  // kept separately for completed and prior-only judgments: only completed ones train the
  // calibration map, so a later prior-only run must not hide an earlier completed one.
  // Judgments run after resolution would leak the answer into calibration.
  const tracesResult = await pool.query(`
    WITH latest_outcomes AS (
      SELECT DISTINCT ON (event_id)
        event_id,
        resolved_value,
        resolved_at,
        resolution_source_url
      FROM outcomes
      ORDER BY event_id, created_at DESC
    )
    SELECT DISTINCT ON (o.event_id, (j.verdict_trace->>'status' = 'completed'))
      o.event_id,
      o.resolved_value,
      o.resolved_at,
      o.resolution_source_url,
      j.verdict_trace
    FROM latest_outcomes o
    JOIN judgments j
      ON j.event_id = o.event_id
    WHERE j.verdict_trace IS NOT NULL
      AND (j.verdict_trace->>'evaluationTime')::timestamptz < o.resolved_at
    ORDER BY
      o.event_id,
      (j.verdict_trace->>'status' = 'completed'),
      (j.verdict_trace->>'evaluationTime')::timestamptz DESC,
      j.created_at DESC
  `);

  // Benchmark market prices from before each market resolved, with how it resolved: the
  // judge service fits how far a market price can be trusted from these.
  const marketPricesResult = await pool.query(`
    SELECT s.benchmark_market_id, s.probability, m.resolved_value
    FROM benchmark_price_snapshots s
    JOIN benchmark_markets m
      ON m.id = s.benchmark_market_id
    WHERE s.source = 'polymarket'
      AND s.cutoff_at < m.resolved_at
    ORDER BY s.benchmark_market_id, s.cutoff_at
  `);

  // Replayed model forecasts that went through the panel, with the probability they had
  // before calibration. A market replayed by several runs counts once per cutoff and
  // baseline, with its newest forecast.
  const forecastsResult = await pool.query(`
    SELECT DISTINCT ON (p.benchmark_market_id, p.cutoff_at, p.baseline)
      p.benchmark_market_id,
      p.outcome,
      p.metadata->'calibration' AS calibration
    FROM evaluation_predictions p
    WHERE p.baseline IN ('model_with_polymarket', 'model_without_polymarket')
      AND p.outcome IS NOT NULL
      AND p.metadata->'calibration'->>'status' = 'completed'
      AND jsonb_typeof(p.metadata->'calibration'->'preCalibrationProbability') = 'number'
    ORDER BY p.benchmark_market_id, p.cutoff_at, p.baseline, p.created_at DESC
  `);

  const historicalTraces: VerdictTrace[] = [];
  const resolvedOutcomes: OutcomeInput[] = [];

  for (const row of outcomesResult.rows as Record<string, unknown>[]) {
    const outcome = OutcomeInputSchema.parse({
      eventId: String(row.event_id),
      resolvedValue: Boolean(row.resolved_value),
      resolvedAt: toIsoString(row.resolved_at),
      resolutionSourceUrl: String(row.resolution_source_url),
    });

    resolvedOutcomes.push(outcome);
  }

  for (const row of tracesResult.rows as Record<string, unknown>[]) {
    const trace = VerdictTraceSchema.parse(row.verdict_trace);

    historicalTraces.push(trace);
  }

  return {
    historicalTraces,
    resolvedOutcomes,
    marketPricePairs: (marketPricesResult.rows as Record<string, unknown>[]).map((row) => ({
      groupId: String(row.benchmark_market_id),
      price: Number(row.probability),
      outcome: Boolean(row.resolved_value),
    })),
    forecastPairs: (forecastsResult.rows as Record<string, unknown>[]).map((row) => {
      const calibration = row.calibration as Record<string, unknown>;

      return {
        groupId: String(row.benchmark_market_id),
        probability: Number(calibration.preCalibrationProbability),
        outcome: Boolean(row.outcome),
        priorProbability:
          typeof calibration.priorProbability === "number" ? calibration.priorProbability : null,
        judgeOpinions: Array.isArray(calibration.judgeOpinions)
          ? (calibration.judgeOpinions as ForecastPair["judgeOpinions"])
          : [],
      };
    }),
  };
}

export async function requestCalibrationSnapshot(args: {
  judgeBaseUrl: string;
  historicalTraces: VerdictTrace[];
  resolvedOutcomes: OutcomeInput[];
  marketPricePairs?: MarketPricePair[];
  forecastPairs?: ForecastPair[];
  fetchImpl?: typeof fetch;
}): Promise<CalibrationSnapshot> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(`${args.judgeBaseUrl}/calibrate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      historicalTraces: args.historicalTraces,
      resolvedOutcomes: args.resolvedOutcomes,
      marketPricePairs: args.marketPricePairs ?? [],
      forecastPairs: args.forecastPairs ?? [],
    }),
  });

  if (!response.ok) {
    throw new Error(`Judge calibration request failed with ${response.status} ${response.statusText}`);
  }

  return CalibrationSnapshotSchema.parse(await response.json());
}

export async function persistCalibrationSnapshotFromService(
  pool: Pool,
  snapshot: CalibrationSnapshot,
): Promise<CalibrationSnapshot> {
  return createCalibrationSnapshot(pool, {
    trainingWindow: snapshot.trainingWindow,
    judgeWeights: snapshot.judgeWeights,
    baseRateParams: snapshot.baseRateParams,
    marketPriorParams: snapshot.marketPriorParams,
    calibrationParams: snapshot.calibrationParams,
    onlineLearningParams: snapshot.onlineLearningParams,
    metrics: snapshot.metrics,
    weightRegime: snapshot.weightRegime,
    resolvedOutcomeCount: snapshot.resolvedOutcomeCount,
    approved: snapshot.approved,
  });
}

/**
 * Fixture mode has no judge service to fit anything, so this records the sample size and
 * regime only. The map stays identity: a snapshot must not claim a fit it does not carry.
 */
export async function retrainCalibrationSnapshot(
  pool: Pool,
  resolvedOutcomeCount: number,
): Promise<CalibrationSnapshot> {
  const weightRegime = selectWeightRegime(resolvedOutcomeCount);

  return createCalibrationSnapshot(pool, {
    trainingWindow: "all_time",
    judgeWeights: DEFAULT_JUDGE_WEIGHTS,
    baseRateParams: {},
    marketPriorParams: {},
    calibrationParams: {
      method: "identity",
    },
    onlineLearningParams: {
      enabled: false,
      stepSizeScale: 0,
    },
    metrics: {},
    weightRegime,
    resolvedOutcomeCount,
    approved: false,
  });
}

/** Approval was refused because the snapshot's map is not shown to help on held-out forecasts. */
export class CalibrationApprovalBlockedError extends Error {}

function describeApprovalBlock(snapshot: CalibrationSnapshot): string | null {
  if (snapshot.calibrationParams.method === undefined || snapshot.calibrationParams.method === "identity") {
    return null;
  }

  const heldOut = snapshot.metrics.heldOut;

  if (!heldOut || typeof heldOut !== "object") {
    return "This snapshot changes forecasts but has no held-out scores, so there is no evidence that it helps.";
  }

  const { improves, brierCalibrated, brierIdentity } = heldOut as Record<string, unknown>;

  if (improves === true) {
    return null;
  }

  return `On held-out forecasts this snapshot's calibration map scores a Brier of ${Number(brierCalibrated).toFixed(4)}, no better than ${Number(brierIdentity).toFixed(4)} for leaving forecasts uncalibrated.`;
}

/**
 * Makes a snapshot the one judgments use. A snapshot whose calibration map is not shown to
 * beat uncalibrated forecasts on held-out data is refused unless `force` is set.
 */
export async function approveCalibrationSnapshot(
  pool: Pool,
  snapshotId: string,
  options: { force?: boolean } = {},
): Promise<CalibrationSnapshot | null> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT * FROM calibration_snapshots WHERE id = $1 FOR UPDATE`,
      [snapshotId],
    );

    if (existing.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const blockReason = options.force
      ? null
      : describeApprovalBlock(mapCalibrationSnapshotRow(existing.rows[0] as Record<string, unknown>));

    if (blockReason) {
      await client.query("ROLLBACK");
      throw new CalibrationApprovalBlockedError(blockReason);
    }

    const result = await client.query(
      `
        UPDATE calibration_snapshots
        SET approved = TRUE
        WHERE id = $1
        RETURNING *
      `,
      [snapshotId],
    );

    await client.query(
      `
        UPDATE calibration_snapshots
        SET approved = FALSE
        WHERE approved = TRUE AND id <> $1
      `,
      [snapshotId],
    );

    await client.query("COMMIT");

    return mapCalibrationSnapshotRow(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    if (!(error instanceof CalibrationApprovalBlockedError)) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
}
