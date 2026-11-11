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

  async function evidenceEvent() {
    return createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
  }

  function article(eventId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      eventId,
      sourceFamily: "web" as const,
      sourceType: "web_article" as const,
      title: "Example Corp teases Product X",
      url: "https://news.example.com/product-x",
      publisher: "Example News",
      publishedAt: "2026-10-10T09:00:00Z",
      retrievedAt: "2026-10-10T10:00:00Z",
      summary: "Product X is expected this year.",
      rawText: null,
      entities: ["Example Corp", "Product X"],
      claims: ["Product X may launch this year"],
      stance: "supports" as const,
      qualitySignals: {},
      metadata: {},
      ...overrides,
    };
  }

  it("stores an unchanged piece of evidence once, however often it is collected", async () => {
    const event = await evidenceEvent();

    const [first] = await insertEvidenceItems(pool, [article(event.id)]);
    const [again] = await insertEvidenceItems(pool, [
      article(event.id, { id: "22222222-2222-4222-8222-222222222222", retrievedAt: "2026-10-12T10:00:00Z" }),
    ]);

    expect(again?.id).toBe(first?.id);
    const evidence = await listEvidenceForEvent(pool, event.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.publishedAt).toBe("2026-10-10T09:00:00.000Z");
  });

  it("keeps the evidence an earlier judgment cited when the same page later says something else", async () => {
    const event = await evidenceEvent();

    const [cited] = await insertEvidenceItems(pool, [article(event.id)]);
    const [revised] = await insertEvidenceItems(pool, [
      article(event.id, { summary: "Example Corp has postponed Product X to next year." }),
    ]);

    expect(revised?.id).not.toBe(cited?.id);
    const evidence = await listEvidenceForEvent(pool, event.id);
    expect(evidence.find((item) => item.id === cited?.id)?.summary).toBe("Product X is expected this year.");
    expect(evidence.find((item) => item.id === revised?.id)?.summary).toBe(
      "Example Corp has postponed Product X to next year.",
    );
  });

  it("stores each market quote, so an earlier judgment's price is not overwritten by a later one", async () => {
    const event = await evidenceEvent();
    const quote = (probability: number, at: string) =>
      article(event.id, {
        sourceFamily: "prediction_market",
        sourceType: "quote_snapshot",
        url: "https://polymarket.com/event/example-product-x",
        publishedAt: at,
        retrievedAt: at,
        metadata: { probability },
      });

    const [earlier] = await insertEvidenceItems(pool, [quote(0.4, "2026-10-10T10:00:00Z")]);
    await insertEvidenceItems(pool, [quote(0.7, "2026-10-12T10:00:00Z")]);

    const evidence = await listEvidenceForEvent(pool, event.id);
    expect(evidence).toHaveLength(2);
    expect(evidence.find((item) => item.id === earlier?.id)?.metadata).toEqual({ probability: 0.4 });
  });

  it("treats an undated item as unchanged when only its placeholder date moved", async () => {
    const event = await evidenceEvent();
    const undated = (at: string) =>
      article(event.id, { publishedAt: at, retrievedAt: at, metadata: { publishedAtSource: "unknown" } });

    const [first] = await insertEvidenceItems(pool, [undated("2026-10-10T10:00:00Z")]);
    const [again] = await insertEvidenceItems(pool, [undated("2026-10-12T10:00:00Z")]);

    expect(again?.id).toBe(first?.id);
    expect(await listEvidenceForEvent(pool, event.id)).toHaveLength(1);
  });

  it("remaps colliding evidence ids so distinct urls can both persist", async () => {
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
        id: "provider-collision",
        eventId: event.id,
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Example Corp launch report A",
        url: "https://news.example.com/product-x-a",
        publisher: "Example News",
        publishedAt: "2026-10-10T09:00:00Z",
        retrievedAt: "2026-10-10T10:00:00Z",
        summary: "First article.",
        rawText: null,
        entities: ["Example Corp", "Product X"],
        claims: ["Product X may launch this year"],
        stance: "supports",
        qualitySignals: {},
        metadata: {},
      },
      {
        id: "provider-collision",
        eventId: event.id,
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Example Corp launch report B",
        url: "https://news.example.com/product-x-b",
        publisher: "Example News",
        publishedAt: "2026-10-10T11:00:00Z",
        retrievedAt: "2026-10-10T12:00:00Z",
        summary: "Second article with the same provider id.",
        rawText: null,
        entities: ["Example Corp", "Product X"],
        claims: ["Product X may launch this year"],
        stance: "supports",
        qualitySignals: {},
        metadata: {},
      },
    ]);

    const evidence = await listEvidenceForEvent(pool, event.id);

    expect(evidence).toHaveLength(2);
    expect(new Set(evidence.map((item) => item.id)).size).toBe(2);
    expect(evidence.map((item) => item.url)).toEqual([
      "https://news.example.com/product-x-a",
      "https://news.example.com/product-x-b",
    ]);
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
