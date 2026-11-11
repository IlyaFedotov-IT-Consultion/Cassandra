import { randomUUID } from "node:crypto";

import type { CalibrationSnapshot, EvidenceItem, VerdictTrace } from "@cassandra/shared";
import { describe, expect, it } from "vitest";

import { getEnv } from "../src/config/env.js";
import { InMemoryJudgeCacheStore } from "../src/modules/judgments/judgeCache.js";
import type { EventRecord } from "../src/modules/events/repository.js";
import {
  evaluateEventForecast,
  evaluatePriorOnlyForecast,
  type JudgeClient,
} from "../src/modules/judgments/service.js";

const fixtureEnv = getEnv({ ...process.env, CASSANDRA_ADAPTER_MODE: "fixture", LOG_LEVEL: "silent" });

const event: EventRecord = {
  id: "event-selection",
  question: "Will Example Corp launch Product X by 2026-12-31?",
  resolutionCriteria: "Official launch announcement.",
  deadline: "2026-12-31T23:59:59Z",
  status: "active",
  entities: ["Example Corp", "Product X"],
  referenceClass: null,
  marketSymbols: [],
  polymarketMarketId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const snapshot: CalibrationSnapshot = {
  id: "snapshot-selection",
  createdAt: "2026-01-01T00:00:00Z",
  trainingWindow: "all_time",
  judgeWeights: {},
  baseRateParams: {},
  marketPriorParams: {},
  calibrationParams: { method: "identity" },
  onlineLearningParams: {},
  metrics: {},
  weightRegime: "cold_start",
  resolvedOutcomeCount: 0,
  approved: false,
};

function evidenceItem(
  sourceFamily: EvidenceItem["sourceFamily"],
  index: number,
  metadata: Record<string, unknown> = {},
): EvidenceItem {
  return {
    id: `${sourceFamily}-${index}`,
    eventId: event.id,
    sourceFamily,
    sourceType: sourceFamily === "prediction_market" ? "polymarket_market" : "web_article",
    title: `Example Corp Product X ${sourceFamily} ${index}`,
    url: `https://example.com/${sourceFamily}/${index}`,
    publisher: "Example",
    publishedAt: `2026-06-0${(index % 9) + 1}T00:00:00Z`,
    retrievedAt: "2026-06-10T00:00:00Z",
    summary: "Example Corp Product X update",
    rawText: null,
    entities: ["Example Corp"],
    claims: [],
    stance: "unknown",
    qualitySignals: {},
    metadata,
  };
}

function judgeTrace(overrides: Partial<VerdictTrace> = {}): VerdictTrace {
  return {
    id: randomUUID(),
    eventId: event.id,
    evaluationTime: "2026-06-10T00:00:00Z",
    referenceClass: null,
    referenceClassFallback: "global_baseline",
    priorProbability: 0.5,
    rawPosteriorProbability: 0.5,
    preCalibrationProbability: 0.5,
    finalProbability: 0.5,
    confidenceLow: 0.4,
    confidenceHigh: 0.6,
    dependencyMatrix: [],
    disagreementShrinkage: 0,
    judgeOpinions: [
      {
        judgeName: "official_records",
        probability: 0.5,
        confidence: 0.55,
        evidenceStrength: "neutral",
        rationale: "Neutral.",
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
    citations: [{ title: "Example", url: "https://example.com/web/0", sourceFamily: "web" }],
    cacheEvents: [],
    modelVersion: "judge-test",
    weightVersion: snapshot.id,
    calibrationVersion: snapshot.id,
    status: "completed",
    ...overrides,
  };
}

function capturingJudgeClient(trace: VerdictTrace) {
  const calls: Array<Parameters<JudgeClient["judge"]>[0]> = [];
  const client: JudgeClient = {
    async judge(input) {
      calls.push(input);
      return trace;
    },
  };
  return { calls, client };
}

function countBy(items: Array<{ sourceFamily: string }>): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.sourceFamily] = (counts[item.sourceFamily] ?? 0) + 1;
    return counts;
  }, {});
}

describe("judge input selection", () => {
  it("sends every judge's source families and the market prior inputs to the judge service", async () => {
    const collected = [
      ...Array.from({ length: 5 }, (_, index) => evidenceItem("official", index)),
      ...Array.from({ length: 5 }, (_, index) => evidenceItem("government", index)),
      ...Array.from({ length: 5 }, (_, index) => evidenceItem("community", index)),
      ...Array.from({ length: 5 }, (_, index) => evidenceItem("web", index)),
      ...Array.from({ length: 5 }, (_, index) => evidenceItem("llm_research", index)),
      evidenceItem("prediction_market", 0, { probability: 0.8, liquidity: 250_000 }),
    ];
    const { calls, client } = capturingJudgeClient(judgeTrace());

    await evaluateEventForecast({
      env: fixtureEnv,
      event,
      evaluationTime: "2026-06-10T00:00:00Z",
      evidence: collected,
      calibrationSnapshot: snapshot,
      judgeClient: client,
    });

    const counts = countBy(calls[0]?.evidence ?? []);
    expect(counts.official).toBeGreaterThan(0);
    expect(counts.government).toBeGreaterThan(0);
    expect((counts.official ?? 0) + (counts.government ?? 0)).toBeLessThanOrEqual(6);
    expect(counts.community).toBe(5);
    expect(counts.web).toBeGreaterThan(0);
    expect(counts.llm_research).toBeGreaterThan(0);
    expect(counts.prediction_market).toBe(1);
  });

  it("delegates insufficient-evidence traces to the judge service in prior-only mode", async () => {
    const market = evidenceItem("prediction_market", 0, { probability: 0.72, liquidity: 500_000 });
    const { calls, client } = capturingJudgeClient(
      judgeTrace({
        priorProbability: 0.72,
        finalProbability: 0.72,
        confidenceLow: 0.6,
        confidenceHigh: 0.8,
        status: "insufficient_evidence",
      }),
    );

    const trace = await evaluatePriorOnlyForecast({
      env: fixtureEnv,
      event,
      evaluationTime: "2026-06-10T00:00:00Z",
      evidence: [market],
      calibrationSnapshot: snapshot,
      judgeClient: client,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.priorOnly).toBe(true);
    expect(calls[0]?.evidence.map((item) => item.id)).toEqual([market.id]);
    expect(trace.status).toBe("insufficient_evidence");
    expect(trace.priorProbability).toBe(0.72);
  });

  it("does not reuse a cached verdict after the market price moved", async () => {
    const liveEnv = getEnv({ ...process.env, CASSANDRA_ADAPTER_MODE: "live", LOG_LEVEL: "silent" });
    const judgeCacheStore = new InMemoryJudgeCacheStore();
    const { calls, client } = capturingJudgeClient(judgeTrace());
    const evidenceAt = (probability: number) => [
      evidenceItem("web", 0),
      evidenceItem("official", 1),
      evidenceItem("prediction_market", 2, { probability, matchedBy: "id" }),
    ];
    const run = (probability: number) =>
      evaluateEventForecast({
        env: liveEnv,
        event,
        evaluationTime: "2026-06-10T00:00:00Z",
        evidence: evidenceAt(probability),
        calibrationSnapshot: snapshot,
        judgeCacheStore,
        judgeClient: client,
      });

    await run(0.4);
    await run(0.4);
    expect(calls).toHaveLength(1);

    await run(0.7);
    expect(calls).toHaveLength(2);
  });
});
