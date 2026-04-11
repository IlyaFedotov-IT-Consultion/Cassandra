import { describe, expect, it, vi } from "vitest";

import type { BenchmarkMarket, EvaluationRun } from "@cassandra/shared";
import {
  createEvaluationRun,
  getEvaluationRunById,
  listBenchmarkMarkets,
  upsertBenchmarkMarkets,
} from "../src/modules/evaluation/repository.js";

describe("evaluation repository", () => {
  it("upserts and lists benchmark markets", async () => {
    const benchmark: BenchmarkMarket = {
      id: "market-1",
      title: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Official launch announcement by deadline.",
      theme: "technology",
      volume: 100000,
      liquidity: 25000,
      resolvedAt: "2026-12-31T23:59:59Z",
      resolvedValue: true,
      marketUrl: "https://polymarket.com/event/example-product-x",
    };

    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: benchmark.id,
            title: benchmark.title,
            resolution_criteria: benchmark.resolutionCriteria,
            theme: benchmark.theme,
            volume: benchmark.volume,
            liquidity: benchmark.liquidity,
            resolved_at: new Date(benchmark.resolvedAt),
            resolved_value: benchmark.resolvedValue,
            market_url: benchmark.marketUrl,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: benchmark.id,
            title: benchmark.title,
            resolution_criteria: benchmark.resolutionCriteria,
            theme: benchmark.theme,
            volume: benchmark.volume,
            liquidity: benchmark.liquidity,
            resolved_at: new Date(benchmark.resolvedAt),
            resolved_value: benchmark.resolvedValue,
            market_url: benchmark.marketUrl,
          },
        ],
      });

    const pool = { query } as never;

    const inserted = await upsertBenchmarkMarkets(pool, [benchmark]);
    const listed = await listBenchmarkMarkets(pool);

    expect(inserted).toEqual([
      {
        ...benchmark,
        resolvedAt: "2026-12-31T23:59:59.000Z",
      },
    ]);
    expect(listed).toEqual([
      {
        ...benchmark,
        resolvedAt: "2026-12-31T23:59:59.000Z",
      },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("creates and hydrates evaluation runs with slice metrics", async () => {
    const runInput: Omit<EvaluationRun, "id" | "createdAt"> = {
      benchmarkSetId: "benchmark-set-1",
      cutoffs: ["2026-12-01T00:00:00Z"],
      baselines: ["model_with_polymarket"],
      overallMetrics: {
        brierScore: 0.12,
      },
      sliceResults: [
        {
          sliceKey: "technology",
          baseline: "model_with_polymarket",
          brierScore: 0.12,
          logLoss: 0.31,
          averageAbsoluteError: 0.22,
          winRateVsPolymarket: 0.6,
          sampleSize: 5,
        },
      ],
      replayFidelity: "approximate",
      leakageWarnings: [],
    };

    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "run-1",
            benchmark_set_id: runInput.benchmarkSetId,
            cutoffs: runInput.cutoffs,
            baselines: runInput.baselines,
            overall_metrics: runInput.overallMetrics,
            replay_fidelity: runInput.replayFidelity,
            leakage_warnings: runInput.leakageWarnings,
            created_at: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "run-1",
            benchmark_set_id: runInput.benchmarkSetId,
            cutoffs: runInput.cutoffs,
            baselines: runInput.baselines,
            overall_metrics: runInput.overallMetrics,
            replay_fidelity: runInput.replayFidelity,
            leakage_warnings: runInput.leakageWarnings,
            created_at: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            slice_key: "technology",
            baseline: "model_with_polymarket",
            brier_score: 0.12,
            log_loss: 0.31,
            average_absolute_error: 0.22,
            win_rate_vs_polymarket: 0.6,
            sample_size: 5,
          },
        ],
      });

    const pool = { query } as never;

    const created = await createEvaluationRun(pool, runInput);
    const loaded = await getEvaluationRunById(pool, created.id);

    expect(created).toMatchObject({
      benchmarkSetId: runInput.benchmarkSetId,
      sliceResults: runInput.sliceResults,
    });
    expect(loaded).toEqual(created);
    expect(query).toHaveBeenCalled();
  });
});
