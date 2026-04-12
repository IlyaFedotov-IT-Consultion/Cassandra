import { describe, expect, it, vi } from "vitest";

import type { BenchmarkMarket, EvaluationRun } from "@cassandra/shared";
import {
  createEvaluationRun,
  createEvaluationRunWithPredictions,
  getEvaluationRunById,
  insertEvaluationPredictions,
  listBenchmarkMarkets,
  listBenchmarkSets,
  listEvaluationPredictionsForRun,
  listPriceSnapshotsForBenchmark,
  syncBenchmarkMarkets,
  upsertBenchmarkPriceSnapshots,
  upsertBenchmarkMarkets,
} from "../src/modules/evaluation/repository.js";

describe("evaluation repository", () => {
  it("upserts and lists benchmark markets", async () => {
    const benchmark: BenchmarkMarket & { benchmarkSetId: string } = {
      benchmarkSetId: "polymarket_recent_resolved",
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
            benchmark_set_id: benchmark.benchmarkSetId,
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
            benchmark_set_id: benchmark.benchmarkSetId,
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
    const listed = await listBenchmarkMarkets(pool, benchmark.benchmarkSetId);

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
    expect(query.mock.calls[0]?.[0]).toContain("benchmark_set_id");
    expect(query.mock.calls[0]?.[1]).toContain(benchmark.benchmarkSetId);
    expect(query.mock.calls[1]?.[0]).toContain("WHERE benchmark_set_id = $1");
    expect(query.mock.calls[1]?.[1]).toEqual([benchmark.benchmarkSetId]);
  });

  it("rejects reassigning a benchmark market to a different benchmark set", async () => {
    const benchmark: BenchmarkMarket = {
      benchmarkSetId: "benchmark-set-2",
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ benchmark_set_id: "benchmark-set-1" }],
      });

    const pool = { query } as never;

    await expect(upsertBenchmarkMarkets(pool, [benchmark])).rejects.toThrow(
      "Benchmark market market-1 already belongs to benchmark set benchmark-set-1",
    );
  });

  it("syncs benchmark markets by deleting stale rows from a benchmark set", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ id: "market-stale" }],
      rowCount: 1,
    });

    const pool = { query } as never;

    const deleted = await syncBenchmarkMarkets(pool, "polymarket_recent_resolved", [
      "market-1",
      "market-2",
    ]);

    expect(deleted).toBe(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM benchmark_markets"),
      ["polymarket_recent_resolved", ["market-1", "market-2"]],
    );
  });

  it("syncs benchmark markets to an empty benchmark set when no markets remain", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ id: "market-1" }, { id: "market-2" }],
      rowCount: 2,
    });

    const pool = { query } as never;

    const deleted = await syncBenchmarkMarkets(pool, "polymarket_recent_resolved", []);

    expect(deleted).toBe(2);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM benchmark_markets"),
      ["polymarket_recent_resolved"],
    );
  });

  it("lists benchmark set summaries", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          benchmark_set_id: "custom-benchmark-set",
          market_count: 2,
          earliest_resolved_at: new Date("2026-12-01T00:00:00Z"),
          latest_resolved_at: new Date("2026-12-31T23:59:59Z"),
          themes: ["crypto", "technology"],
        },
        {
          benchmark_set_id: "polymarket_recent_resolved",
          market_count: 1,
          earliest_resolved_at: new Date("2026-11-15T00:00:00Z"),
          latest_resolved_at: new Date("2026-11-15T00:00:00Z"),
          themes: ["politics"],
        },
      ],
    });
    const pool = { query } as never;
    const summaries = await listBenchmarkSets(pool);

    expect(summaries).toEqual([
      {
        benchmarkSetId: "custom-benchmark-set",
        marketCount: 2,
        earliestResolvedAt: "2026-12-01T00:00:00.000Z",
        latestResolvedAt: "2026-12-31T23:59:59.000Z",
        themes: ["crypto", "technology"],
      },
      {
        benchmarkSetId: "polymarket_recent_resolved",
        marketCount: 1,
        earliestResolvedAt: "2026-11-15T00:00:00.000Z",
        latestResolvedAt: "2026-11-15T00:00:00.000Z",
        themes: ["politics"],
      },
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("GROUP BY benchmark_set_id");
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

    const clientQuery = vi
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
      .mockResolvedValueOnce({ rows: [] });

    const query = vi
      .fn()
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
    const release = vi.fn();
    const connect = vi.fn(async () => ({
      query: clientQuery,
      release,
    }));

    const pool = { query, connect } as never;

    const created = await createEvaluationRun(pool, runInput);
    const loaded = await getEvaluationRunById(pool, created.id);

    expect(created).toMatchObject({
      benchmarkSetId: runInput.benchmarkSetId,
      sliceResults: runInput.sliceResults,
    });
    expect(loaded).toEqual(created);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO evaluation_runs"),
      expect.stringContaining("INSERT INTO evaluation_slice_metrics"),
      "COMMIT",
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("creates evaluation runs and predictions atomically", async () => {
    const runInput: Omit<EvaluationRun, "id" | "createdAt"> = {
      benchmarkSetId: "benchmark-set-1",
      cutoffs: ["30d"],
      baselines: ["model_with_polymarket"],
      overallMetrics: {
        benchmarkCount: 1,
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

    const clientQuery = vi
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
      .mockResolvedValueOnce({
        rows: [
          {
            id: "prediction-1",
            evaluation_run_id: "run-1",
            benchmark_market_id: "market-1",
            baseline: "model_with_polymarket",
            cutoff_at: new Date("2026-12-01T00:00:00Z"),
            predicted_probability: 0.67,
            outcome: true,
            theme: "technology",
            horizon: "30d",
            source_configuration: "full_pipeline",
            metadata: {},
            created_at: new Date("2026-12-01T00:01:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const connect = vi.fn(async () => ({
      query: clientQuery,
      release,
    }));

    const pool = { connect } as never;

    const created = await createEvaluationRunWithPredictions(pool, {
      run: runInput,
      predictions: [
        {
          benchmarkMarketId: "market-1",
          baseline: "model_with_polymarket",
          cutoffAt: "2026-12-01T00:00:00Z",
          predictedProbability: 0.67,
          outcome: true,
          theme: "technology",
          horizon: "30d",
          sourceConfiguration: "full_pipeline",
          metadata: {},
        },
      ],
    });

    expect(created).toMatchObject({
      benchmarkSetId: "benchmark-set-1",
      baselines: ["model_with_polymarket"],
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO evaluation_runs"),
      expect.stringContaining("INSERT INTO evaluation_slice_metrics"),
      expect.stringContaining("INSERT INTO evaluation_predictions"),
      "COMMIT",
    ]);
  });

  it("rolls back and releases the client when prediction persistence fails", async () => {
    const runInput: Omit<EvaluationRun, "id" | "createdAt"> = {
      benchmarkSetId: "benchmark-set-1",
      cutoffs: ["30d"],
      baselines: ["model_with_polymarket"],
      overallMetrics: {
        benchmarkCount: 1,
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

    const clientQuery = vi
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
      .mockRejectedValueOnce(new Error("prediction insert failed"))
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const connect = vi.fn(async () => ({
      query: clientQuery,
      release,
    }));

    const pool = { connect } as never;

    await expect(
      createEvaluationRunWithPredictions(pool, {
        run: runInput,
        predictions: [
          {
            benchmarkMarketId: "market-1",
            baseline: "model_with_polymarket",
            cutoffAt: "2026-12-01T00:00:00Z",
            predictedProbability: 0.67,
            outcome: true,
            theme: "technology",
            horizon: "30d",
            sourceConfiguration: "full_pipeline",
            metadata: {},
          },
        ],
      }),
    ).rejects.toThrow("prediction insert failed");

    expect(clientQuery.mock.calls.map((call) => call[0])).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO evaluation_runs"),
      expect.stringContaining("INSERT INTO evaluation_slice_metrics"),
      expect.stringContaining("INSERT INTO evaluation_predictions"),
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("upserts and lists benchmark price snapshots", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "snapshot-1",
            benchmark_market_id: "market-1",
            cutoff_at: new Date("2026-12-01T00:00:00Z"),
            probability: 0.61,
            volume: 10000,
            liquidity: 5000,
            source: "polymarket",
            created_at: new Date("2026-12-01T00:01:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "snapshot-1",
            benchmark_market_id: "market-1",
            cutoff_at: new Date("2026-12-01T00:00:00Z"),
            probability: 0.61,
            volume: 10000,
            liquidity: 5000,
            source: "polymarket",
            created_at: new Date("2026-12-01T00:01:00Z"),
          },
        ],
      });

    const pool = { query } as never;

    const inserted = await upsertBenchmarkPriceSnapshots(pool, [
      {
        benchmarkMarketId: "market-1",
        cutoffAt: "2026-12-01T00:00:00Z",
        probability: 0.61,
        volume: 10000,
        liquidity: 5000,
        source: "polymarket",
      },
    ]);
    const listed = await listPriceSnapshotsForBenchmark(pool, "market-1");

    expect(inserted).toEqual([
      {
        id: "snapshot-1",
        benchmarkMarketId: "market-1",
        cutoffAt: "2026-12-01T00:00:00.000Z",
        probability: 0.61,
        volume: 10000,
        liquidity: 5000,
        source: "polymarket",
        createdAt: "2026-12-01T00:01:00.000Z",
      },
    ]);
    expect(listed).toEqual(inserted);
  });

  it("inserts and lists evaluation predictions for a run", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "prediction-1",
            evaluation_run_id: "run-1",
            benchmark_market_id: "market-1",
            baseline: "model_with_polymarket",
            cutoff_at: new Date("2026-12-01T00:00:00Z"),
            predicted_probability: 0.67,
            outcome: true,
            theme: "technology",
            horizon: "30d",
            source_configuration: "full_pipeline",
            metadata: {
              replayFidelity: "exact",
            },
            created_at: new Date("2026-12-01T00:01:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "prediction-1",
            evaluation_run_id: "run-1",
            benchmark_market_id: "market-1",
            baseline: "model_with_polymarket",
            cutoff_at: new Date("2026-12-01T00:00:00Z"),
            predicted_probability: 0.67,
            outcome: true,
            theme: "technology",
            horizon: "30d",
            source_configuration: "full_pipeline",
            metadata: {
              replayFidelity: "exact",
            },
            created_at: new Date("2026-12-01T00:01:00Z"),
          },
        ],
      });

    const pool = { query } as never;

    const inserted = await insertEvaluationPredictions(pool, "run-1", [
      {
        benchmarkMarketId: "market-1",
        baseline: "model_with_polymarket",
        cutoffAt: "2026-12-01T00:00:00Z",
        predictedProbability: 0.67,
        outcome: true,
        theme: "technology",
        horizon: "30d",
        sourceConfiguration: "full_pipeline",
        metadata: {
          replayFidelity: "exact",
        },
      },
    ]);
    const listed = await listEvaluationPredictionsForRun(pool, "run-1");

    expect(inserted).toEqual([
      {
        id: "prediction-1",
        evaluationRunId: "run-1",
        benchmarkMarketId: "market-1",
        baseline: "model_with_polymarket",
        cutoffAt: "2026-12-01T00:00:00.000Z",
        predictedProbability: 0.67,
        outcome: true,
        theme: "technology",
        horizon: "30d",
        sourceConfiguration: "full_pipeline",
        metadata: {
          replayFidelity: "exact",
        },
        createdAt: "2026-12-01T00:01:00.000Z",
      },
    ]);
    expect(listed).toEqual(inserted);
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT");
  });
});
