import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { VerdictTrace } from "@cassandra/shared";
import { createDbPool } from "../src/lib/db.js";
import { insertEvidenceItems, listEvidenceForEvent } from "../src/modules/evidence/repository.js";
import { createEvent, getEventById } from "../src/modules/events/repository.js";
import {
  appendJudgmentTrace,
  createJudgmentRun,
  getJudgmentById,
  listJudgeOpinionsForJudgment,
} from "../src/modules/judgments/repository.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra";

const pool = createDbPool(DATABASE_URL);

async function resetDatabase() {
  await pool.query(`
    TRUNCATE TABLE
      judge_opinions,
      judgments,
      evidence_items,
      outcomes,
      candidate_events,
      calibration_snapshots,
      events,
      watchlists
    RESTART IDENTITY CASCADE
  `);
}

describe("repository layer", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("inserts and fetches an event including referenceClass", async () => {
    const created = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: ["EXMPL"],
      polymarketMarketId: "market-123",
    });

    const loaded = await getEventById(pool, created.id);

    expect(loaded).not.toBeNull();
    expect(loaded?.question).toContain("Product X");
    expect(loaded?.referenceClass).toBe("product_launch");
    expect(loaded?.marketSymbols).toEqual(["EXMPL"]);
  });

  it("deduplicates evidence rows while preserving publishedAt", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });

    await insertEvidenceItems(pool, [
      {
        id: "11111111-1111-4111-8111-111111111111",
        eventId: event.id,
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Example Corp teases Product X",
        url: "https://news.example.com/product-x",
        publisher: "Example News",
        publishedAt: "2026-10-10T09:00:00Z",
        retrievedAt: "2026-10-10T10:00:00Z",
        summary: "Product X is expected this year.",
        rawText: null,
        entities: ["Example Corp", "Product X"],
        claims: ["Product X may launch this year"],
        stance: "supports",
        qualitySignals: {},
        metadata: {},
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        eventId: event.id,
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Example Corp teases Product X again",
        url: "https://news.example.com/product-x",
        publisher: "Example News",
        publishedAt: "2026-10-10T09:00:00Z",
        retrievedAt: "2026-10-10T11:00:00Z",
        summary: "Same article discovered twice.",
        rawText: null,
        entities: ["Example Corp", "Product X"],
        claims: ["Product X may launch this year"],
        stance: "supports",
        qualitySignals: {},
        metadata: {},
      },
    ]);

    const evidence = await listEvidenceForEvent(pool, event.id);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.publishedAt).toBe("2026-10-10T09:00:00.000Z");
    expect(evidence[0]?.url).toBe("https://news.example.com/product-x");
  });

  it("appends judgment trace history and persists judge opinions", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });

    const judgment = await createJudgmentRun(pool, event.id);

    const verdictTrace: VerdictTrace = {
      id: "33333333-3333-4333-8333-333333333333",
      eventId: event.id,
      evaluationTime: "2026-11-01T12:00:00Z",
      referenceClass: "product_launch",
      referenceClassFallback: null,
      priorProbability: 0.35,
      rawPosteriorProbability: 0.58,
      finalProbability: 0.6,
      confidenceLow: 0.51,
      confidenceHigh: 0.68,
      dependencyMatrix: [],
      disagreementShrinkage: 0.1,
      judgeOpinions: [
        {
          judgeName: "open_web_research",
          probability: 0.6,
          confidence: 0.7,
          evidenceStrength: "weak_for",
          rationale: "Several corroborating reports suggest a launch is near.",
          evidenceIds: ["evidence-1"],
          warnings: [],
          logBayesFactor: 0.2,
          baseWeight: 0.8,
          dependencyDiscount: 1,
          freshnessDecay: 0.95,
          effectiveLogOddsContribution: 0.152,
          missingEvidence: [],
        },
      ],
      weightBreakdown: [
        {
          source: "open_web_research",
          weight: 0.8,
          details: {},
        },
      ],
      ensembleMethod: "logarithmic_opinion_pool",
      calibrationMethod: "isotonic",
      uncertaintyMethod: "bootstrap",
      weightRegime: "warming",
      replayFidelity: "approximate",
      conflicts: [],
      missingEvidence: [],
      citations: [
        {
          title: "Example report",
          url: "https://news.example.com/product-x",
          sourceFamily: "web",
        },
      ],
      modelVersion: "judge-v1",
      weightVersion: "weights-v1",
      calibrationVersion: "cal-v1",
      status: "completed",
    };

    await appendJudgmentTrace(pool, judgment.id, verdictTrace);

    const storedJudgment = await getJudgmentById(pool, judgment.id);
    const storedOpinions = await listJudgeOpinionsForJudgment(pool, judgment.id);

    expect(storedJudgment?.status).toBe("completed");
    expect(storedJudgment?.verdictTrace?.finalProbability).toBe(0.6);
    expect(storedOpinions).toHaveLength(1);
    expect(storedOpinions[0]?.judgeName).toBe("open_web_research");
  });
});
