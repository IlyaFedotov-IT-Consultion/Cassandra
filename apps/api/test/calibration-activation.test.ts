import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { CalibrationSnapshot, VerdictTrace } from "@cassandra/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";
import { createDbPool } from "../src/lib/db.js";
import {
  BASELINE_CALIBRATION_SNAPSHOT_ID,
  CalibrationApprovalBlockedError,
  approveCalibrationSnapshot,
  createCalibrationSnapshot,
  getActiveCalibrationSnapshot,
  getCalibrationSnapshotById,
  loadCalibrationTrainingData,
  retrainCalibrationSnapshot,
} from "../src/modules/backtests/repository.js";
import { createEvent } from "../src/modules/events/repository.js";
import { upsertBenchmarkMarkets, upsertBenchmarkPriceSnapshots } from "../src/modules/evaluation/repository.js";
import { appendJudgmentTrace, createJudgmentRun } from "../src/modules/judgments/repository.js";
import { createOutcome } from "../src/modules/outcomes/repository.js";

const pool = createDbPool(
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra_test",
);

function snapshotInput(
  overrides: Partial<Omit<CalibrationSnapshot, "id" | "createdAt">> = {},
): Omit<CalibrationSnapshot, "id" | "createdAt"> {
  return {
    trainingWindow: "all_time",
    judgeWeights: { official_records: 0.5, community_signal: 0.2, open_web_research: 0.3 },
    baseRateParams: {},
    marketPriorParams: {},
    calibrationParams: { method: "logistic", slope: 0.5, intercept: 0 },
    onlineLearningParams: { enabled: true },
    metrics: {},
    weightRegime: "warming",
    resolvedOutcomeCount: 40,
    approved: false,
    ...overrides,
  };
}

const HELD_OUT_BETTER = { heldOut: { folds: 5, sampleSize: 40, brierIdentity: 0.3, brierCalibrated: 0.25, improves: true } };
const HELD_OUT_WORSE = { heldOut: { folds: 5, sampleSize: 40, brierIdentity: 0.25, brierCalibrated: 0.27, improves: false } };

function trace(eventId: string, evaluationTime: string, status: VerdictTrace["status"]): VerdictTrace {
  return {
    id: randomUUID(),
    eventId,
    evaluationTime,
    referenceClass: null,
    referenceClassFallback: null,
    priorProbability: 0.5,
    rawPosteriorProbability: 0.6,
    preCalibrationProbability: 0.6,
    finalProbability: 0.6,
    confidenceLow: 0.6,
    confidenceHigh: 0.6,
    dependencyMatrix: [],
    disagreementShrinkage: 0,
    judgeOpinions: [
      {
        judgeName: "official_records",
        probability: 0.6,
        confidence: 0.6,
        evidenceStrength: "neutral",
        rationale: "Test.",
        evidenceIds: [],
        warnings: [],
        logBayesFactor: 0,
        baseWeight: 1 / 3,
        dependencyDiscount: 1,
        freshnessDecay: 1,
        effectiveLogOddsContribution: 0,
        missingEvidence: [],
      },
    ],
    weightBreakdown: [],
    ensembleMethod: "logarithmic_opinion_pool",
    calibrationMethod: "identity",
    uncertaintyMethod: "none",
    weightRegime: "cold_start",
    replayFidelity: "exact",
    conflicts: [],
    missingEvidence: [],
    citations: [{ title: "Test", url: "https://example.com/test", sourceFamily: "web" }],
    cacheEvents: [],
    pipelineStages: [],
    modelVersion: "test",
    weightVersion: "test",
    calibrationVersion: "test",
    status,
  };
}

afterAll(async () => {
  await pool.end();
});

describe("calibration snapshot activation", () => {
  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE judge_opinions, judgments, evidence_items, outcomes, calibration_snapshots, events,
        evaluation_predictions, evaluation_runs, benchmark_price_snapshots, benchmark_markets RESTART IDENTITY CASCADE`,
    );
  });

  it("uses the identity baseline while no snapshot is approved", async () => {
    await createCalibrationSnapshot(pool, snapshotInput());

    const active = await getActiveCalibrationSnapshot(pool);

    expect(active.id).toBe(BASELINE_CALIBRATION_SNAPSHOT_ID);
    expect(active.calibrationParams).toEqual({ method: "identity" });
    expect(active.judgeWeights).toEqual({});
  });

  it("uses the approved snapshot even when a newer unapproved one exists", async () => {
    const older = await createCalibrationSnapshot(pool, snapshotInput({ metrics: HELD_OUT_BETTER }));
    await approveCalibrationSnapshot(pool, older.id);
    await createCalibrationSnapshot(pool, snapshotInput());

    expect((await getActiveCalibrationSnapshot(pool)).id).toBe(older.id);
  });

  it("refuses to approve a calibration map whose held-out score is no better than leaving forecasts alone", async () => {
    const snapshot = await createCalibrationSnapshot(pool, snapshotInput({ metrics: HELD_OUT_WORSE }));

    await expect(approveCalibrationSnapshot(pool, snapshot.id)).rejects.toBeInstanceOf(
      CalibrationApprovalBlockedError,
    );
    expect((await getCalibrationSnapshotById(pool, snapshot.id))?.approved).toBe(false);
  });

  it("refuses to approve a calibration map that has no held-out score", async () => {
    const snapshot = await createCalibrationSnapshot(pool, snapshotInput());

    await expect(approveCalibrationSnapshot(pool, snapshot.id)).rejects.toThrow(/held-out/i);
  });

  it("approves a blocked snapshot when the operator forces it", async () => {
    const snapshot = await createCalibrationSnapshot(pool, snapshotInput({ metrics: HELD_OUT_WORSE }));

    const approved = await approveCalibrationSnapshot(pool, snapshot.id, { force: true });

    expect(approved?.approved).toBe(true);
  });

  it("approves an identity snapshot without held-out scores", async () => {
    const snapshot = await createCalibrationSnapshot(
      pool,
      snapshotInput({ calibrationParams: { method: "identity" }, weightRegime: "cold_start" }),
    );

    expect((await approveCalibrationSnapshot(pool, snapshot.id))?.approved).toBe(true);
  });

  it("answers 409 with the reason when approval is blocked, and 200 when forced", async () => {
    const snapshot = await createCalibrationSnapshot(pool, snapshotInput({ metrics: HELD_OUT_WORSE }));
    const app = buildApp({
      dbPool: pool,
      env: getEnv({ CASSANDRA_ADAPTER_MODE: "fixture" }),
    });

    try {
      const blocked = await app.inject({
        method: "POST",
        url: `/backtests/calibration-snapshots/${snapshot.id}/approve`,
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toMatch(/0\.27.*0\.25/);

      const forced = await app.inject({
        method: "POST",
        url: `/backtests/calibration-snapshots/${snapshot.id}/approve`,
        payload: { force: true },
      });
      expect(forced.statusCode).toBe(200);
      expect(forced.json()).toMatchObject({ id: snapshot.id, approved: true });
    } finally {
      await app.close();
    }
  });

  it("labels a locally created snapshot as identity, because nothing was fitted", async () => {
    const snapshot = await retrainCalibrationSnapshot(pool, 150);

    expect(snapshot.calibrationParams).toEqual({ method: "identity" });
    expect(snapshot.weightRegime).toBe("steady");
  });
});

describe("calibration training data sources", () => {
  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE judge_opinions, judgments, evidence_items, outcomes, calibration_snapshots, events,
        evaluation_predictions, evaluation_runs, benchmark_price_snapshots, benchmark_markets RESTART IDENTITY CASCADE`,
    );
  });

  it("offers benchmark market prices from before each market resolved as market-trust training pairs", async () => {
    await upsertBenchmarkMarkets(pool, [
      {
        id: "market-yes",
        benchmarkSetId: "set-1",
        title: "Will A happen?",
        resolutionCriteria: "A happens.",
        theme: "technology",
        volume: 1000,
        liquidity: 500,
        resolvedAt: "2026-06-10T00:00:00Z",
        endDate: "2026-06-30T00:00:00Z",
        resolvedValue: true,
        marketUrl: "https://polymarket.com/event/a",
      },
    ]);
    await upsertBenchmarkPriceSnapshots(pool, [
      { benchmarkMarketId: "market-yes", cutoffAt: "2026-06-01T00:00:00Z", probability: 0.7, volume: 0, liquidity: 0, source: "polymarket" },
      // After the resolution the price only restates the outcome.
      { benchmarkMarketId: "market-yes", cutoffAt: "2026-06-29T00:00:00Z", probability: 0.999, volume: 0, liquidity: 0, source: "polymarket" },
    ]);

    const data = await loadCalibrationTrainingData(pool);

    expect(data.marketPricePairs).toEqual([{ groupId: "market-yes", price: 0.7, outcome: true }]);
  });

  it("keeps an event's completed judgment when a later one was prior-only", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Official launch announcement.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: null,
      marketSymbols: [],
    });
    for (const [evaluationTime, status] of [
      ["2026-10-01T00:00:00Z", "completed"],
      ["2026-11-01T00:00:00Z", "insufficient_evidence"],
    ] as const) {
      const judgment = await createJudgmentRun(pool, event.id);
      await appendJudgmentTrace(pool, judgment.id, trace(event.id, evaluationTime, status));
    }
    await createOutcome(pool, {
      eventId: event.id,
      resolvedValue: true,
      resolvedAt: "2026-12-10T00:00:00Z",
      resolutionSourceUrl: "https://example.com/resolution",
    });

    const data = await loadCalibrationTrainingData(pool);

    expect(data.historicalTraces.map((item) => item.status).sort()).toEqual([
      "completed",
      "insufficient_evidence",
    ]);
  });

  it("leaves replayed forecasts out of a retrain when asked to", async () => {
    await upsertBenchmarkMarkets(pool, [
      {
        id: "market-replayed",
        benchmarkSetId: "set-1",
        title: "Will A happen?",
        resolutionCriteria: "A happens.",
        theme: "technology",
        volume: 1000,
        liquidity: 500,
        resolvedAt: "2026-06-10T00:00:00Z",
        endDate: "2026-06-09T00:00:00Z",
        resolvedValue: true,
        marketUrl: "https://polymarket.com/event/a",
      },
    ]);
    const run = await pool.query(
      `INSERT INTO evaluation_runs (id, benchmark_set_id, cutoffs, baselines)
       VALUES (gen_random_uuid(), 'set-1', '["7d"]'::jsonb, '["model_without_polymarket"]'::jsonb) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO evaluation_predictions (evaluation_run_id, benchmark_market_id, baseline, cutoff_at, predicted_probability, outcome, metadata)
       VALUES ($1, 'market-replayed', 'model_without_polymarket', '2026-06-02T00:00:00Z', 0.7, true, $2::jsonb)`,
      [
        run.rows[0].id,
        JSON.stringify({ calibration: { preCalibrationProbability: 0.7, priorProbability: 0.5, status: "completed", judgeOpinions: [] } }),
      ],
    );
    const sent: Array<{ forecastPairs: unknown[] }> = [];
    const judge = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        sent.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "snapshot-from-judge",
            createdAt: "2026-06-11T00:00:00Z",
            ...snapshotInput({ calibrationParams: { method: "identity" }, weightRegime: "cold_start" }),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => judge.listen(0, "127.0.0.1", resolve));
    const app = buildApp({
      dbPool: pool,
      env: getEnv({
        CASSANDRA_ADAPTER_MODE: "live",
        JUDGE_BASE_URL: `http://127.0.0.1:${(judge.address() as AddressInfo).port}`,
      }),
    });

    try {
      await app.inject({ method: "POST", url: "/backtests/retrain" });
      await app.inject({ method: "POST", url: "/backtests/retrain", payload: { includeReplay: false } });

      expect(sent.map((request) => request.forecastPairs.length)).toEqual([1, 0]);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => judge.close(() => resolve()));
    }
  });
});
