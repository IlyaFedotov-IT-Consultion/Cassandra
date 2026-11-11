import type { BenchmarkMarket } from "@cassandra/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";
import { createDbPool } from "../src/lib/db.js";
import { loadCalibrationTrainingData } from "../src/modules/backtests/repository.js";
import type { EvaluationJobQueue } from "../src/modules/evaluation/jobQueue.js";
import {
  createQueuedEvaluationRun,
  getEvaluationRunById,
  failEvaluationRun,
  listBenchmarkMarkets,
  syncBenchmarkMarkets,
  listEvaluationPredictionsForRun,
  upsertBenchmarkMarkets,
  upsertBenchmarkPriceSnapshots,
} from "../src/modules/evaluation/repository.js";
import { executeEvaluationRun, type EvaluateModelBaselineArgs } from "../src/modules/evaluation/replay.js";

const pool = createDbPool(
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra_test",
);
const liveEnv = getEnv({ CASSANDRA_ADAPTER_MODE: "live" });

function market(id: string, resolvedValue: boolean): BenchmarkMarket {
  return {
    id,
    benchmarkSetId: "set-queued",
    title: `Will ${id} happen by 2026-12-30?`,
    resolutionCriteria: `${id} happens.`,
    theme: "technology",
    volume: 1000,
    liquidity: 500,
    resolvedAt: "2026-12-31T12:00:00Z",
    endDate: "2026-12-30T00:00:00Z",
    resolvedValue,
    marketUrl: `https://polymarket.com/event/${id}`,
  };
}

async function seedBenchmark(ids: string[]) {
  await upsertBenchmarkMarkets(pool, ids.map((id, index) => market(id, index % 2 === 0)));
  await upsertBenchmarkPriceSnapshots(
    pool,
    ids.map((id) => ({
      benchmarkMarketId: id,
      cutoffAt: "2026-11-01T00:00:00Z",
      probability: 0.6,
      volume: 0,
      liquidity: 0,
      source: "polymarket",
    })),
  );
}

function modelBaseline(probability: number, failOn?: string) {
  const calls: string[] = [];
  const evaluate = async ({ market: evaluated, cutoff }: EvaluateModelBaselineArgs) => {
    calls.push(`${evaluated.id}@${cutoff.horizon}`);

    if (evaluated.id === failOn) {
      throw new Error("judge service is down");
    }

    return {
      probability,
      replayFidelity: "approximate" as const,
      calibration: {
        preCalibrationProbability: probability,
        priorProbability: 0.5,
        status: "completed" as const,
        calibrationVersion: "baseline-identity",
        judgeOpinions: [{ judgeName: "open_web_research", logBayesFactor: 1.5, hadEvidence: true }],
      },
    };
  };
  return { calls, evaluate };
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE evaluation_slice_metrics, evaluation_predictions, evaluation_runs,
      benchmark_price_snapshots, benchmark_markets, judge_opinions, judgments, outcomes, events RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await pool.end();
});

describe("queued evaluation runs", () => {
  it("queues a run and answers at once, without evaluating anything in the request", async () => {
    await seedBenchmark(["alpha", "beta"]);
    const enqueue = vi.fn(async (_job: { runId: string }) => undefined);
    const app = buildApp({
      dbPool: pool,
      env: liveEnv,
      evaluationQueue: { enqueue, close: async () => undefined } as EvaluationJobQueue,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/runs",
        payload: { benchmarkSetId: "set-queued", baselines: ["polymarket_only"] },
      });

      expect(response.statusCode).toBe(202);
      const run = response.json();
      expect(run).toMatchObject({
        status: "queued",
        baselines: ["polymarket_only"],
        progress: { completedMarkets: 0, totalMarkets: 2 },
      });
      expect(enqueue).toHaveBeenCalledWith({ runId: run.id });
      expect(await listEvaluationPredictionsForRun(pool, run.id)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("refuses to queue a run for a benchmark set with no markets", async () => {
    const app = buildApp({
      dbPool: pool,
      env: liveEnv,
      evaluationQueue: { enqueue: vi.fn(), close: async () => undefined } as unknown as EvaluationJobQueue,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/runs",
        payload: { benchmarkSetId: "missing-set", baselines: ["polymarket_only"] },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  async function queuedRun(ids: string[]) {
    await seedBenchmark(ids);
    return createQueuedEvaluationRun(pool, {
      benchmarkSetId: "set-queued",
      baselines: ["polymarket_only", "model_without_polymarket"],
      request: { benchmarkSetId: "set-queued", baselines: ["polymarket_only", "model_without_polymarket"] },
      totalMarkets: ids.length,
    });
  }

  it("runs a queued run to completion and scores it", async () => {
    const run = await queuedRun(["alpha", "beta"]);
    const model = modelBaseline(0.7);

    await executeEvaluationRun({ pool, env: liveEnv, runId: run.id, evaluateModelBaseline: model.evaluate });

    const finished = await getEvaluationRunById(pool, run.id);
    expect(finished).toMatchObject({ status: "completed", progress: { completedMarkets: 2, totalMarkets: 2 } });
    // Two markets, four horizons, two baselines.
    expect(await listEvaluationPredictionsForRun(pool, run.id)).toHaveLength(16);
    const metrics = finished?.overallMetrics as { byBaseline: Record<string, { sampleSize: number }> };
    expect(metrics.byBaseline.model_without_polymarket?.sampleSize).toBe(8);
    expect(finished?.sliceResults.length).toBeGreaterThan(0);
    // Model 0.7 against the market's 0.6: 0.07 better on the Yes market, 0.13 worse on the No market.
    const paired = (finished?.overallMetrics as { paired: { vsPolymarket: Record<string, { mean: number; groups: number }> } }).paired;
    expect(paired.vsPolymarket.model_without_polymarket?.mean).toBeCloseTo(0.03, 6);
    expect(paired.vsPolymarket.model_without_polymarket?.groups).toBe(2);
  });

  it("reports no scores for a baseline that produced no forecasts", async () => {
    const run = await queuedRun(["alpha"]);
    const allFail = async () => {
      throw new Error("judge service is down");
    };

    await executeEvaluationRun({ pool, env: liveEnv, runId: run.id, evaluateModelBaseline: allFail });

    const finished = await getEvaluationRunById(pool, run.id);
    const metrics = finished?.overallMetrics as { byBaseline: Record<string, Record<string, unknown>> };
    expect(metrics.byBaseline.model_without_polymarket).toEqual({ sampleSize: 0 });
    expect(metrics.byBaseline.polymarket_only?.sampleSize).toBe(4);
  });

  it("keeps the forecasts of finished markets when a later market fails the run", async () => {
    const run = await queuedRun(["alpha", "beta"]);
    const failing = modelBaseline(0.7);
    const explode = async () => {
      throw new Error("database went away");
    };

    await expect(
      executeEvaluationRun({
        pool,
        env: liveEnv,
        runId: run.id,
        evaluateModelBaseline: failing.evaluate,
        onMarketCompleted: async ({ market: completed }) => {
          if (completed.id === "beta") {
            await explode();
          }
        },
      }),
    ).rejects.toThrow("database went away");

    const failed = await getEvaluationRunById(pool, run.id);
    expect(failed).toMatchObject({ status: "failed", error: "database went away" });
    expect(failed?.progress).toMatchObject({ completedMarkets: 1 });
    const stored = await listEvaluationPredictionsForRun(pool, run.id);
    expect(new Set(stored.map((prediction) => prediction.benchmarkMarketId))).toEqual(new Set(["alpha"]));
  });

  it("resumes a run without paying again for forecasts it already stored", async () => {
    const run = await queuedRun(["alpha", "beta"]);
    const first = modelBaseline(0.7);
    await expect(
      executeEvaluationRun({
        pool,
        env: liveEnv,
        runId: run.id,
        evaluateModelBaseline: first.evaluate,
        onMarketCompleted: async ({ market: completed }) => {
          if (completed.id === "beta") {
            throw new Error("interrupted");
          }
        },
      }),
    ).rejects.toThrow("interrupted");

    const second = modelBaseline(0.7);
    await executeEvaluationRun({ pool, env: liveEnv, runId: run.id, evaluateModelBaseline: second.evaluate });

    expect(second.calls.every((call) => call.startsWith("beta@"))).toBe(true);
    expect(second.calls).toHaveLength(4);
    expect(await getEvaluationRunById(pool, run.id)).toMatchObject({ status: "completed", error: null });
    expect(await listEvaluationPredictionsForRun(pool, run.id)).toHaveLength(16);
  });

  it("preserves historical forecasts when an import replaces the current market selection", async () => {
    const run = await queuedRun(["alpha", "beta"]);
    await executeEvaluationRun({ pool, env: liveEnv, runId: run.id, evaluateModelBaseline: modelBaseline(0.7).evaluate });
    await syncBenchmarkMarkets(pool, "set-queued", ["beta"]);

    expect((await listBenchmarkMarkets(pool, "set-queued")).map((row) => row.id)).toEqual(["beta"]);
    expect(await listEvaluationPredictionsForRun(pool, run.id)).toHaveLength(16);
    const training = await loadCalibrationTrainingData(pool);
    expect(training.forecastPairs).toHaveLength(8);
    expect(training.marketPricePairs.map((pair) => pair.groupId)).toEqual(["alpha", "beta"]);
  });

  it("resumes a failed run through the API once, retaining its forecasts", async () => {
    await seedBenchmark(["alpha", "beta"]);
    const run = await createQueuedEvaluationRun(pool, {
      benchmarkSetId: "set-queued", baselines: ["polymarket_only"], totalMarkets: 2,
      request: { benchmarkSetId: "set-queued", baselines: ["polymarket_only"], benchmarkMarketIds: ["alpha", "beta"] },
    });
    await expect(executeEvaluationRun({ pool, env: liveEnv, runId: run.id,
      onMarketCompleted: async ({ market: completed }) => {
        if (completed.id === "beta") throw new Error("interrupted");
      },
    })).rejects.toThrow("interrupted");
    const enqueue = vi.fn(async (_job: { runId: string }) => undefined);
    const app = buildApp({ dbPool: pool, env: liveEnv, evaluationQueue: { enqueue, close: async () => undefined } });
    try {
      const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `/evaluation/runs/${run.id}/resume` })));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
      expect(enqueue).toHaveBeenCalledExactlyOnceWith({ runId: run.id });
      expect(await listEvaluationPredictionsForRun(pool, run.id)).toHaveLength(4);
      await syncBenchmarkMarkets(pool, "set-queued", []);
      await executeEvaluationRun({ pool, env: liveEnv, runId: run.id });
      expect(await getEvaluationRunById(pool, run.id)).toMatchObject({ status: "completed", error: null });
      expect(await listEvaluationPredictionsForRun(pool, run.id)).toHaveLength(8);
    } finally { await app.close(); }
  });

  it("leaves a failed run resumable if the queue rejects submission", async () => {
    await seedBenchmark(["alpha"]);
    const run = await createQueuedEvaluationRun(pool, {
      benchmarkSetId: "set-queued", baselines: ["polymarket_only"], totalMarkets: 1,
      request: { benchmarkSetId: "set-queued", baselines: ["polymarket_only"] },
    });
    await failEvaluationRun(pool, run.id, "interrupted");
    const app = buildApp({ dbPool: pool, env: liveEnv,
      evaluationQueue: { enqueue: async () => { throw new Error("queue unavailable"); }, close: async () => undefined },
    });
    try {
      expect((await app.inject({ method: "POST", url: `/evaluation/runs/${run.id}/resume` })).statusCode).toBe(500);
      expect(await getEvaluationRunById(pool, run.id)).toMatchObject({ status: "failed", error: "queue unavailable" });
    } finally { await app.close(); }
  });

  it("records what calibration needs from each model forecast, and offers it as training data", async () => {
    const run = await queuedRun(["alpha", "beta"]);

    await executeEvaluationRun({ pool, env: liveEnv, runId: run.id, evaluateModelBaseline: modelBaseline(0.7).evaluate });

    const model = (await listEvaluationPredictionsForRun(pool, run.id)).find(
      (prediction) => prediction.baseline === "model_without_polymarket",
    );
    expect(model?.metadata.calibration).toMatchObject({
      preCalibrationProbability: 0.7,
      priorProbability: 0.5,
      status: "completed",
    });

    const training = await loadCalibrationTrainingData(pool);
    expect(training.forecastPairs).toHaveLength(8);
    expect(training.forecastPairs[0]).toEqual({
      groupId: "alpha",
      probability: 0.7,
      outcome: true,
      priorProbability: 0.5,
      judgeOpinions: [{ judgeName: "open_web_research", logBayesFactor: 1.5, hadEvidence: true }],
    });
  });

  it("offers each forecast once when a market was replayed by several runs, taking the newest", async () => {
    const older = await queuedRun(["alpha"]);
    await executeEvaluationRun({ pool, env: liveEnv, runId: older.id, evaluateModelBaseline: modelBaseline(0.2).evaluate });
    const newer = await createQueuedEvaluationRun(pool, {
      benchmarkSetId: "set-queued",
      baselines: ["model_without_polymarket"],
      request: { benchmarkSetId: "set-queued", baselines: ["model_without_polymarket"] },
      totalMarkets: 1,
    });
    await executeEvaluationRun({ pool, env: liveEnv, runId: newer.id, evaluateModelBaseline: modelBaseline(0.9).evaluate });

    const training = await loadCalibrationTrainingData(pool);

    expect(training.forecastPairs.map((pair) => pair.probability)).toEqual([0.9, 0.9, 0.9, 0.9]);
  });
});
