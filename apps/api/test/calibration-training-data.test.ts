import { randomUUID } from "node:crypto";

import type { VerdictTrace } from "@cassandra/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDbPool } from "../src/lib/db.js";
import { loadCalibrationTrainingData } from "../src/modules/backtests/repository.js";
import { createEvent } from "../src/modules/events/repository.js";
import { appendJudgmentTrace, createJudgmentRun } from "../src/modules/judgments/repository.js";
import { createOutcome } from "../src/modules/outcomes/repository.js";

const pool = createDbPool(
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra_test",
);

function trace(eventId: string, evaluationTime: string, finalProbability: number): VerdictTrace {
  return {
    id: randomUUID(),
    eventId,
    evaluationTime,
    referenceClass: null,
    referenceClassFallback: null,
    priorProbability: 0.5,
    rawPosteriorProbability: finalProbability,
    preCalibrationProbability: finalProbability,
    finalProbability,
    confidenceLow: finalProbability,
    confidenceHigh: finalProbability,
    dependencyMatrix: [],
    disagreementShrinkage: 0,
    judgeOpinions: [
      {
        judgeName: "official_records",
        probability: finalProbability,
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
    modelVersion: "test",
    weightVersion: "test",
    calibrationVersion: "test",
    status: "completed",
  };
}

async function recordJudgment(eventId: string, evaluationTime: string, finalProbability: number) {
  const judgment = await createJudgmentRun(pool, eventId);
  await appendJudgmentTrace(pool, judgment.id, trace(eventId, evaluationTime, finalProbability));
}

describe("calibration training data", () => {
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE TABLE judge_opinions, judgments, evidence_items, outcomes, calibration_snapshots, events RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("uses each event's latest judgment made before resolution, not one made afterwards", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Official launch announcement.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: null,
      marketSymbols: [],
    });
    await recordJudgment(event.id, "2026-10-01T00:00:00Z", 0.3);
    await recordJudgment(event.id, "2026-11-01T00:00:00Z", 0.4);
    await recordJudgment(event.id, "2026-12-15T00:00:00Z", 0.97);
    await createOutcome(pool, {
      eventId: event.id,
      resolvedValue: true,
      resolvedAt: "2026-12-10T00:00:00Z",
      resolutionSourceUrl: "https://example.com/resolution",
    });

    const data = await loadCalibrationTrainingData(pool);

    expect(data.historicalTraces.map((item) => item.finalProbability)).toEqual([0.4]);
  });

  it("returns one outcome per event, the most recently recorded", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp ship Product Y by 2026-12-31?",
      resolutionCriteria: "Official announcement.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: null,
      marketSymbols: [],
    });
    await createOutcome(pool, {
      eventId: event.id,
      resolvedValue: false,
      resolvedAt: "2026-12-10T00:00:00Z",
      resolutionSourceUrl: "https://example.com/first",
    });
    await createOutcome(pool, {
      eventId: event.id,
      resolvedValue: true,
      resolvedAt: "2026-12-11T00:00:00Z",
      resolutionSourceUrl: "https://example.com/corrected",
    });

    const data = await loadCalibrationTrainingData(pool);

    expect(data.resolvedOutcomes).toHaveLength(1);
    expect(data.resolvedOutcomes[0]).toMatchObject({
      resolvedValue: true,
      resolutionSourceUrl: "https://example.com/corrected",
    });
  });
});
