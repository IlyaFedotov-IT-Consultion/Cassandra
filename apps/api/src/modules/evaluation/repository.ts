import { randomUUID } from "node:crypto";

import {
  BenchmarkMarketSchema,
  EvaluationRunSchema,
  type BenchmarkMarket,
  type EvaluationRun,
} from "@cassandra/shared";
import type { Pool } from "pg";

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapBenchmarkMarketRow(row: Record<string, unknown>): BenchmarkMarket {
  return BenchmarkMarketSchema.parse({
    id: String(row.id),
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
          title,
          resolution_criteria,
          theme,
          volume,
          liquidity,
          resolved_at,
          resolved_value,
          market_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        RETURNING *
      `,
      [
        market.id,
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

    inserted.push(mapBenchmarkMarketRow(result.rows[0] as Record<string, unknown>));
  }

  return inserted;
}

export async function listBenchmarkMarkets(pool: Pool): Promise<BenchmarkMarket[]> {
  const result = await pool.query(`
    SELECT *
    FROM benchmark_markets
    ORDER BY resolved_at DESC, id ASC
  `);

  return result.rows.map((row) => mapBenchmarkMarketRow(row as Record<string, unknown>));
}

export async function createEvaluationRun(
  pool: Pool,
  input: Omit<EvaluationRun, "id" | "createdAt">,
): Promise<EvaluationRun> {
  await pool.query("BEGIN");

  try {
    const runId = randomUUID();
    const runResult = await pool.query(
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
      await pool.query(
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

    await pool.query("COMMIT");

    return mapEvaluationRunRow(
      runResult.rows[0] as Record<string, unknown>,
      input.sliceResults,
    );
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
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
