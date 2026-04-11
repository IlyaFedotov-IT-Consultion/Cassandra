import { randomUUID } from "node:crypto";

import {
  BenchmarkMarketSchema,
  EvaluationRunSchema,
  type BenchmarkMarket,
  type EvaluationRun,
} from "@cassandra/shared";
import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

export interface BenchmarkPriceSnapshotInput {
  benchmarkMarketId: string;
  cutoffAt: string;
  probability: number;
  volume: number;
  liquidity: number;
  source: string;
}

export interface BenchmarkPriceSnapshotRecord extends BenchmarkPriceSnapshotInput {
  id: string;
  createdAt: string;
}

export interface EvaluationPredictionInput {
  benchmarkMarketId: string;
  baseline: EvaluationRun["baselines"][number];
  cutoffAt: string;
  predictedProbability: number;
  outcome: boolean | null;
  theme?: string;
  horizon?: string;
  sourceConfiguration?: string;
  metadata?: Record<string, unknown>;
}

export interface EvaluationPredictionRecord extends EvaluationPredictionInput {
  id: string;
  evaluationRunId: string;
  createdAt: string;
}

export interface BenchmarkSetSummary {
  benchmarkSetId: string;
  marketCount: number;
  earliestResolvedAt: string;
  latestResolvedAt: string;
  themes: string[];
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapBenchmarkMarketRow(row: Record<string, unknown>): BenchmarkMarket {
  return BenchmarkMarketSchema.parse({
    id: String(row.id),
    benchmarkSetId: row.benchmark_set_id,
    title: String(row.title),
    resolutionCriteria: String(row.resolution_criteria),
    theme: String(row.theme),
    volume: Number(row.volume),
    liquidity: Number(row.liquidity),
    resolvedAt: toIsoString(row.resolved_at),
    resolvedValue: Boolean(row.resolved_value),
    marketUrl: String(row.market_url),
  });
}

function mapEvaluationRunRow(
  row: Record<string, unknown>,
  sliceResults: EvaluationRun["sliceResults"],
): EvaluationRun {
  return EvaluationRunSchema.parse({
    id: String(row.id),
    benchmarkSetId: String(row.benchmark_set_id),
    cutoffs: Array.isArray(row.cutoffs) ? row.cutoffs : [],
    baselines: Array.isArray(row.baselines) ? row.baselines : [],
    overallMetrics:
      row.overall_metrics && typeof row.overall_metrics === "object"
        ? (row.overall_metrics as Record<string, unknown>)
        : {},
    sliceResults,
    replayFidelity: String(row.replay_fidelity),
    leakageWarnings: Array.isArray(row.leakage_warnings) ? row.leakage_warnings : [],
    createdAt: toIsoString(row.created_at),
  });
}

function mapSliceMetricRow(
  row: Record<string, unknown>,
): EvaluationRun["sliceResults"][number] {
  return {
    sliceKey: String(row.slice_key),
    baseline: String(row.baseline) as EvaluationRun["sliceResults"][number]["baseline"],
    brierScore: Number(row.brier_score),
    logLoss: Number(row.log_loss),
    averageAbsoluteError: Number(row.average_absolute_error),
    winRateVsPolymarket:
      row.win_rate_vs_polymarket === null || row.win_rate_vs_polymarket === undefined
        ? undefined
        : Number(row.win_rate_vs_polymarket),
    sampleSize: Number(row.sample_size),
  };
}

function mapBenchmarkPriceSnapshotRow(
  row: Record<string, unknown>,
): BenchmarkPriceSnapshotRecord {
  return {
    id: String(row.id),
    benchmarkMarketId: String(row.benchmark_market_id),
    cutoffAt: toIsoString(row.cutoff_at),
    probability: Number(row.probability),
    volume: Number(row.volume),
    liquidity: Number(row.liquidity),
    source: String(row.source),
    createdAt: toIsoString(row.created_at),
  };
}

function mapEvaluationPredictionRow(
  row: Record<string, unknown>,
): EvaluationPredictionRecord {
  return {
    id: String(row.id),
    evaluationRunId: String(row.evaluation_run_id),
    benchmarkMarketId: String(row.benchmark_market_id),
    baseline: String(row.baseline) as EvaluationRun["baselines"][number],
    cutoffAt: toIsoString(row.cutoff_at),
    predictedProbability: Number(row.predicted_probability),
    outcome:
      row.outcome === null || row.outcome === undefined ? null : Boolean(row.outcome),
    theme: row.theme === null || row.theme === undefined ? undefined : String(row.theme),
    horizon: row.horizon === null || row.horizon === undefined ? undefined : String(row.horizon),
    sourceConfiguration:
      row.source_configuration === null || row.source_configuration === undefined
        ? undefined
        : String(row.source_configuration),
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: toIsoString(row.created_at),
  };
}

function mapBenchmarkSetSummaryRow(row: Record<string, unknown>): BenchmarkSetSummary {
  return {
    benchmarkSetId: String(row.benchmark_set_id),
    marketCount: Number(row.market_count),
    earliestResolvedAt: toIsoString(row.earliest_resolved_at),
    latestResolvedAt: toIsoString(row.latest_resolved_at),
    themes: Array.isArray(row.themes) ? row.themes.map((theme) => String(theme)) : [],
  };
}

export async function upsertBenchmarkMarkets(
  pool: Pool,
  markets: BenchmarkMarket[],
): Promise<BenchmarkMarket[]> {
  const inserted: BenchmarkMarket[] = [];

  for (const market of markets) {
    const result = await pool.query(
      `
        INSERT INTO benchmark_markets (
          id,
          benchmark_set_id,
          title,
          resolution_criteria,
          theme,
          volume,
          liquidity,
          resolved_at,
          resolved_value,
          market_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id)
        DO UPDATE SET
          title = EXCLUDED.title,
          resolution_criteria = EXCLUDED.resolution_criteria,
          theme = EXCLUDED.theme,
          volume = EXCLUDED.volume,
          liquidity = EXCLUDED.liquidity,
          resolved_at = EXCLUDED.resolved_at,
          resolved_value = EXCLUDED.resolved_value,
          market_url = EXCLUDED.market_url,
          updated_at = NOW()
        WHERE benchmark_markets.benchmark_set_id = EXCLUDED.benchmark_set_id
        RETURNING *
      `,
      [
        market.id,
        market.benchmarkSetId,
        market.title,
        market.resolutionCriteria,
        market.theme,
        market.volume,
        market.liquidity,
        market.resolvedAt,
        market.resolvedValue,
        market.marketUrl,
      ],
    );

    if (result.rows.length === 0) {
      const existing = await pool.query(
        `
          SELECT benchmark_set_id
          FROM benchmark_markets
          WHERE id = $1
        `,
        [market.id],
      );

      const existingBenchmarkSetId = existing.rows[0]?.benchmark_set_id;

      if (typeof existingBenchmarkSetId === "string" && existingBenchmarkSetId.length > 0) {
        throw new Error(
          `Benchmark market ${market.id} already belongs to benchmark set ${existingBenchmarkSetId}`,
        );
      }

      throw new Error(`Failed to upsert benchmark market ${market.id}`);
    }

    inserted.push(mapBenchmarkMarketRow(result.rows[0] as Record<string, unknown>));
  }

  return inserted;
}

export async function listBenchmarkMarkets(
  pool: Pool,
  benchmarkSetId?: string,
): Promise<BenchmarkMarket[]> {
  const result = benchmarkSetId
    ? await pool.query(
        `
          SELECT *
          FROM benchmark_markets
          WHERE benchmark_set_id = $1
          ORDER BY resolved_at DESC, id ASC
        `,
        [benchmarkSetId],
      )
    : await pool.query(`
        SELECT *
        FROM benchmark_markets
        ORDER BY resolved_at DESC, id ASC
      `);

  return result.rows.map((row) => mapBenchmarkMarketRow(row as Record<string, unknown>));
}

export async function listBenchmarkSets(pool: Pool): Promise<BenchmarkSetSummary[]> {
  const result = await pool.query(`
    SELECT
      benchmark_set_id,
      COUNT(*) AS market_count,
      MIN(resolved_at) AS earliest_resolved_at,
      MAX(resolved_at) AS latest_resolved_at,
      ARRAY_AGG(DISTINCT theme ORDER BY theme) AS themes
    FROM benchmark_markets
    GROUP BY benchmark_set_id
    ORDER BY latest_resolved_at DESC, benchmark_set_id ASC
  `);

  return result.rows.map((row) => mapBenchmarkSetSummaryRow(row as Record<string, unknown>));
}

export async function upsertBenchmarkPriceSnapshots(
  pool: Pool,
  snapshots: BenchmarkPriceSnapshotInput[],
): Promise<BenchmarkPriceSnapshotRecord[]> {
  const inserted: BenchmarkPriceSnapshotRecord[] = [];

  for (const snapshot of snapshots) {
    const result = await pool.query(
      `
        INSERT INTO benchmark_price_snapshots (
          benchmark_market_id,
          cutoff_at,
          probability,
          volume,
          liquidity,
          source
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (benchmark_market_id, cutoff_at, source)
        DO UPDATE SET
          probability = EXCLUDED.probability,
          volume = EXCLUDED.volume,
          liquidity = EXCLUDED.liquidity
        RETURNING *
      `,
      [
        snapshot.benchmarkMarketId,
        snapshot.cutoffAt,
        snapshot.probability,
        snapshot.volume,
        snapshot.liquidity,
        snapshot.source,
      ],
    );

    inserted.push(mapBenchmarkPriceSnapshotRow(result.rows[0] as Record<string, unknown>));
  }

  return inserted;
}

export async function listPriceSnapshotsForBenchmark(
  pool: Pool,
  benchmarkMarketId: string,
): Promise<BenchmarkPriceSnapshotRecord[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM benchmark_price_snapshots
      WHERE benchmark_market_id = $1
      ORDER BY cutoff_at ASC, created_at ASC
    `,
    [benchmarkMarketId],
  );

  return result.rows.map((row) => mapBenchmarkPriceSnapshotRow(row as Record<string, unknown>));
}

export async function insertEvaluationPredictions(
  queryable: Queryable,
  evaluationRunId: string,
  predictions: EvaluationPredictionInput[],
): Promise<EvaluationPredictionRecord[]> {
  const inserted: EvaluationPredictionRecord[] = [];

  for (const prediction of predictions) {
    const result = await queryable.query(
      `
        INSERT INTO evaluation_predictions (
          evaluation_run_id,
          benchmark_market_id,
          baseline,
          cutoff_at,
          predicted_probability,
          outcome,
          theme,
          horizon,
          source_configuration,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        ON CONFLICT (evaluation_run_id, benchmark_market_id, baseline, cutoff_at)
        DO UPDATE SET
          predicted_probability = EXCLUDED.predicted_probability,
          outcome = EXCLUDED.outcome,
          theme = EXCLUDED.theme,
          horizon = EXCLUDED.horizon,
          source_configuration = EXCLUDED.source_configuration,
          metadata = EXCLUDED.metadata
        RETURNING *
      `,
      [
        evaluationRunId,
        prediction.benchmarkMarketId,
        prediction.baseline,
        prediction.cutoffAt,
        prediction.predictedProbability,
        prediction.outcome,
        prediction.theme ?? null,
        prediction.horizon ?? null,
        prediction.sourceConfiguration ?? null,
        JSON.stringify(prediction.metadata ?? {}),
      ],
    );

    inserted.push(mapEvaluationPredictionRow(result.rows[0] as Record<string, unknown>));
  }

  return inserted;
}
export async function listEvaluationPredictionsForRun(
  pool: Pool,
  evaluationRunId: string,
): Promise<EvaluationPredictionRecord[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM evaluation_predictions
      WHERE evaluation_run_id = $1
      ORDER BY cutoff_at ASC, benchmark_market_id ASC, baseline ASC, created_at ASC
    `,
    [evaluationRunId],
  );

  return result.rows.map((row) => mapEvaluationPredictionRow(row as Record<string, unknown>));
}

async function insertEvaluationRun(
  queryable: Queryable,
  input: Omit<EvaluationRun, "id" | "createdAt">,
): Promise<EvaluationRun> {
  const runId = randomUUID();
  const runResult = await queryable.query(
    `
      INSERT INTO evaluation_runs (
        id,
        benchmark_set_id,
        cutoffs,
        baselines,
        overall_metrics,
        replay_fidelity,
        leakage_warnings
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::jsonb)
      RETURNING *
    `,
    [
      runId,
      input.benchmarkSetId,
      JSON.stringify(input.cutoffs),
      JSON.stringify(input.baselines),
      JSON.stringify(input.overallMetrics),
      input.replayFidelity,
      JSON.stringify(input.leakageWarnings),
    ],
  );

  for (const slice of input.sliceResults) {
    await queryable.query(
      `
        INSERT INTO evaluation_slice_metrics (
          id,
          evaluation_run_id,
          slice_key,
          baseline,
          brier_score,
          log_loss,
          average_absolute_error,
          win_rate_vs_polymarket,
          sample_size
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        randomUUID(),
        runId,
        slice.sliceKey,
        slice.baseline,
        slice.brierScore,
        slice.logLoss,
        slice.averageAbsoluteError,
        slice.winRateVsPolymarket ?? null,
        slice.sampleSize,
      ],
    );
  }

  return mapEvaluationRunRow(
    runResult.rows[0] as Record<string, unknown>,
    input.sliceResults,
  );
}

export async function createEvaluationRun(
  pool: Pool,
  input: Omit<EvaluationRun, "id" | "createdAt">,
): Promise<EvaluationRun> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const run = await insertEvaluationRun(client, input);
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createEvaluationRunWithPredictions(
  pool: Pool,
  input: {
    run: Omit<EvaluationRun, "id" | "createdAt">;
    predictions: EvaluationPredictionInput[];
  },
): Promise<EvaluationRun> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const run = await insertEvaluationRun(client, input.run);
    await insertEvaluationPredictions(client, run.id, input.predictions);
    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getEvaluationRunById(
  pool: Pool,
  runId: string,
): Promise<EvaluationRun | null> {
  const runResult = await pool.query(`SELECT * FROM evaluation_runs WHERE id = $1`, [runId]);

  if (runResult.rowCount === 0) {
    return null;
  }

  const sliceResult = await pool.query(
    `
      SELECT *
      FROM evaluation_slice_metrics
      WHERE evaluation_run_id = $1
      ORDER BY slice_key ASC, baseline ASC
    `,
    [runId],
  );

  return mapEvaluationRunRow(
    runResult.rows[0] as Record<string, unknown>,
    sliceResult.rows.map((row) => mapSliceMetricRow(row as Record<string, unknown>)),
  );
}
