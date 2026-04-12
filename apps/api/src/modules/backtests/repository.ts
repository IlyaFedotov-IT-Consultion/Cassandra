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

export async function getLatestCalibrationSnapshot(
  pool: Pool,
): Promise<CalibrationSnapshot | null> {
  const result = await pool.query(`
    SELECT *
    FROM calibration_snapshots
    ORDER BY created_at DESC
    LIMIT 1
  `);

  if (result.rowCount === 0) {
    return null;
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
    ORDER BY created_at DESC
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

export async function loadCalibrationTrainingData(
  pool: Pool,
): Promise<{
  historicalTraces: VerdictTrace[];
  resolvedOutcomes: OutcomeInput[];
}> {
  const outcomesResult = await pool.query(`
    SELECT
      event_id,
      resolved_value,
      resolved_at,
      resolution_source_url
    FROM outcomes
    ORDER BY created_at ASC, event_id ASC
  `);

  const tracesResult = await pool.query(`
    SELECT DISTINCT ON (o.event_id)
      o.event_id,
      o.resolved_value,
      o.resolved_at,
      o.resolution_source_url,
      j.verdict_trace
    FROM outcomes o
    JOIN judgments j
      ON j.event_id = o.event_id
    WHERE j.verdict_trace IS NOT NULL
    ORDER BY o.event_id, j.updated_at DESC, j.created_at DESC
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
  };
}

export async function requestCalibrationSnapshot(args: {
  judgeBaseUrl: string;
  historicalTraces: VerdictTrace[];
  resolvedOutcomes: OutcomeInput[];
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

export async function retrainCalibrationSnapshot(
  pool: Pool,
  resolvedOutcomeCount: number,
): Promise<CalibrationSnapshot> {
  const weightRegime = selectWeightRegime(resolvedOutcomeCount);
  const calibrationMethod =
    weightRegime === "steady"
      ? "isotonic"
      : weightRegime === "warming"
        ? "logistic"
        : "identity";

  return createCalibrationSnapshot(pool, {
    trainingWindow: "all_time",
    judgeWeights: DEFAULT_JUDGE_WEIGHTS,
    baseRateParams: {},
    marketPriorParams: {},
    calibrationParams: {
      method: calibrationMethod,
    },
    onlineLearningParams: {
      enabled: weightRegime !== "cold_start",
      stepSizeScale: weightRegime === "warming" ? 0.5 : weightRegime === "steady" ? 1 : 0,
    },
    metrics: {},
    weightRegime,
    resolvedOutcomeCount,
    approved: false,
  });
}
