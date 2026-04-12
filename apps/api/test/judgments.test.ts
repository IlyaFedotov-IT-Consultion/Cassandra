import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalibrationSnapshot, EvidenceItem } from "@cassandra/shared";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";
import { createDbPool } from "../src/lib/db.js";
import { createLogger } from "../src/lib/logger.js";
import { createEvent } from "../src/modules/events/repository.js";
import { InMemoryJudgeCacheStore } from "../src/modules/judgments/judgeCache.js";
import {
  appendJudgmentTrace,
  createJudgmentRun,
  getJudgmentById,
  listJudgments,
} from "../src/modules/judgments/repository.js";
import {
  createDefaultEvidenceProviders,
  evaluateEventForecast,
  runJudgment,
} from "../src/modules/judgments/service.js";

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

function createFixtureEnv(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return getEnv({
    DATABASE_URL,
    REDIS_URL: "redis://localhost:6379",
    CASSANDRA_ADAPTER_MODE: "fixture",
    ...overrides,
  });
}

function buildEvidenceItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: randomUUID(),
    eventId: "event-1",
    sourceFamily: "web",
    sourceType: "web_article",
    title: "Example Corp moves closer to launch",
    url: `https://example.com/${randomUUID()}`,
    publisher: "Example News",
    publishedAt: "2026-10-10T09:00:00Z",
    retrievedAt: "2026-10-10T10:00:00Z",
    summary: "Analysts expect a launch announcement soon.",
    rawText: null,
    entities: ["Example Corp", "Product X"],
    claims: ["Example Corp may launch Product X before year end"],
    stance: "supports",
    qualitySignals: {},
    metadata: {},
    ...overrides,
  };
}

function buildCalibrationSnapshot(): CalibrationSnapshot {
  return {
    id: "snapshot-1",
    createdAt: "2026-10-01T00:00:00Z",
    trainingWindow: "all_time",
    judgeWeights: {
      official_records: 0.4,
      community_signal: 0.2,
      open_web_research: 0.4,
    },
    baseRateParams: {},
    marketPriorParams: {},
    calibrationParams: {
      method: "identity",
    },
    onlineLearningParams: {
      enabled: false,
    },
    metrics: {},
    weightRegime: "cold_start",
    resolvedOutcomeCount: 0,
    approved: false,
  };
}

async function waitForCompletedJudgment(app: ReturnType<typeof buildApp>, judgmentId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/judgments/${judgmentId}`,
    });

    expect(response.statusCode).toBe(200);
    const judgment = response.json();

    if (
      judgment.status === "completed" ||
      judgment.status === "insufficient_evidence" ||
      judgment.status === "failed"
    ) {
      return judgment;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Judgment ${judgmentId} did not finish in time`);
}

describe("judgment routes and service", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("queues a judgment run and the worker advances it to completed with citations and calibration metadata", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: ["EXMPL"],
      polymarketMarketId: "poly-1",
    });

    const app = buildApp({
      dbPool: pool,
      env: createFixtureEnv(),
    });

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/judgments",
        payload: {
          eventId: event.id,
          evaluationTime: "2026-10-11T12:00:00Z",
        },
      });

      expect(createResponse.statusCode).toBe(202);

      const queued = createResponse.json();

      expect(queued).toMatchObject({
        eventId: event.id,
        status: "queued",
      });

      const completed = await waitForCompletedJudgment(app, queued.id);

      expect(completed).toMatchObject({
        id: queued.id,
        eventId: event.id,
        status: "completed",
        verdictTrace: expect.objectContaining({
          eventId: event.id,
          status: "completed",
          citations: expect.any(Array),
          judgeOpinions: expect.any(Array),
          calibrationVersion: expect.any(String),
          weightVersion: expect.any(String),
          cacheEvents: expect.arrayContaining([
            expect.objectContaining({
              layer: "judge_output",
            }),
          ]),
        }),
        judgeOpinions: expect.any(Array),
      });

      expect(completed.verdictTrace.citations.length).toBeGreaterThan(0);
      expect(completed.judgeOpinions.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("emits judgment pipeline logs without duplicate JSON keys", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: ["EXMPL"],
      polymarketMarketId: "poly-1",
    });

    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(...chunk.toString().split("\n").filter(Boolean));
        callback();
      },
    });
    const app = buildApp({
      dbPool: pool,
      env: createFixtureEnv(),
      logger: createLogger({
        component: "test",
        destination,
        level: "info",
      }),
    });

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/judgments",
        payload: {
          eventId: event.id,
          evaluationTime: "2026-10-11T12:00:00Z",
        },
      });

      expect(createResponse.statusCode).toBe(202);
      const queued = createResponse.json();
      await waitForCompletedJudgment(app, queued.id);

      const evidenceLine = lines.find((line) => line.includes("\"event\":\"evidence_collection_completed\""));

      expect(evidenceLine).toBeDefined();
      expect(evidenceLine?.match(/"component":/g) ?? []).toHaveLength(1);
      expect(evidenceLine?.match(/"eventId":/g) ?? []).toHaveLength(1);
      expect(evidenceLine?.match(/"evaluationTime":/g) ?? []).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("returns an explicit insufficient_evidence status with a neutral-ish probability when no evidence is available", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp secure approval by 2026-12-31?",
      resolutionCriteria: "Approval must be announced by the regulator.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: "regulatory_approval",
      marketSymbols: [],
    });

    const queued = await createJudgmentRun(pool, event.id);

    const completed = await runJudgment({
      pool,
      env: createFixtureEnv(),
      input: {
        judgmentId: queued.id,
        eventId: event.id,
        evaluationTime: "2026-10-11T12:00:00Z",
      },
      evidenceProviders: [
        {
          name: "empty-fixture-provider",
          async collect() {
            return [];
          },
        },
      ],
    });

    expect(completed.status).toBe("insufficient_evidence");
    expect(completed.verdictTrace?.status).toBe("insufficient_evidence");
    expect(completed.verdictTrace?.finalProbability).toBeGreaterThanOrEqual(0.4);
    expect(completed.verdictTrace?.finalProbability).toBeLessThanOrEqual(0.6);
    expect(completed.verdictTrace?.citations.length).toBeGreaterThan(0);
  });

  it("lists recent judgments in reverse chronological order", async () => {
    const firstEvent = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const secondEvent = await createEvent(pool, {
      question: "Will Example Corp secure approval by 2026-12-31?",
      resolutionCriteria: "Approval must be announced by the regulator.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: "regulatory_approval",
      marketSymbols: [],
    });

    const firstJudgment = await createJudgmentRun(pool, firstEvent.id);
    await appendJudgmentTrace(pool, firstJudgment.id, {
      id: randomUUID(),
      eventId: firstEvent.id,
      evaluationTime: "2026-10-11T12:00:00Z",
      referenceClass: firstEvent.referenceClass,
      referenceClassFallback: null,
      priorProbability: 0.5,
      rawPosteriorProbability: 0.62,
      finalProbability: 0.6,
      confidenceLow: 0.5,
      confidenceHigh: 0.7,
      dependencyMatrix: [],
      disagreementShrinkage: 0.02,
      judgeOpinions: [],
      weightBreakdown: [],
      ensembleMethod: "logarithmic_opinion_pool",
      calibrationMethod: "identity",
      uncertaintyMethod: "bootstrap",
      weightRegime: "cold_start",
      replayFidelity: "exact",
      conflicts: [],
      missingEvidence: [],
      citations: [],
      modelVersion: "judge-v1",
      weightVersion: "snapshot-1",
      calibrationVersion: "snapshot-1",
      status: "completed",
      cacheEvents: [],
    });

    const secondJudgment = await createJudgmentRun(pool, secondEvent.id);

    const judgments = await listJudgments(pool);

    expect(judgments).toHaveLength(2);
    expect(judgments.map((judgment) => judgment.id)).toEqual([
      secondJudgment.id,
      firstJudgment.id,
    ]);
    expect(judgments[0]).toMatchObject({
      eventId: secondEvent.id,
      status: "queued",
      verdictTrace: null,
    });
    expect(judgments[1]).toMatchObject({
      eventId: firstEvent.id,
      status: "completed",
      verdictTrace: expect.objectContaining({
        finalProbability: 0.6,
      }),
    });
  });

  it("returns recent judgments from the collection route", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const judgment = await createJudgmentRun(pool, event.id);
    const app = buildApp({
      dbPool: pool,
      env: createFixtureEnv(),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/judgments",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          id: judgment.id,
          eventId: event.id,
          status: "queued",
          verdictTrace: null,
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("filters the collection route by event id", async () => {
    const firstEvent = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const secondEvent = await createEvent(pool, {
      question: "Will Example Corp secure approval by 2026-12-31?",
      resolutionCriteria: "Approval must be announced by the regulator.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: "regulatory_approval",
      marketSymbols: [],
    });
    const firstJudgment = await createJudgmentRun(pool, firstEvent.id);
    await createJudgmentRun(pool, secondEvent.id);

    const app = buildApp({
      dbPool: pool,
      env: createFixtureEnv(),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/judgments?eventId=${encodeURIComponent(firstEvent.id)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          id: firstJudgment.id,
          eventId: firstEvent.id,
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("reuses the cached judge output in live mode without re-invoking the judge service", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const calibrationSnapshot = buildCalibrationSnapshot();
    const judgeCacheStore = new InMemoryJudgeCacheStore();
    const evidence = [
      buildEvidenceItem({
        sourceFamily: "official",
        sourceType: "press_release",
      }),
    ];
    const judgeClient = {
      judge: vi.fn(async () => ({
        id: randomUUID(),
        eventId: event.id,
        evaluationTime: "2026-10-11T12:00:00Z",
        referenceClass: event.referenceClass,
        referenceClassFallback: null,
        priorProbability: 0.5,
        rawPosteriorProbability: 0.68,
        finalProbability: 0.66,
        confidenceLow: 0.56,
        confidenceHigh: 0.76,
        dependencyMatrix: [],
        disagreementShrinkage: 0.05,
        judgeOpinions: [
          {
            judgeName: "official_records",
            probability: 0.66,
            confidence: 0.8,
            evidenceStrength: "moderate_for" as const,
            rationale: "Official announcement supports the launch.",
            evidenceIds: [evidence[0]!.id],
            warnings: [],
            logBayesFactor: 1.5,
            baseWeight: 0.4,
            dependencyDiscount: 1,
            freshnessDecay: 1,
            effectiveLogOddsContribution: 0.6,
            missingEvidence: [],
          },
        ],
        weightBreakdown: [],
        ensembleMethod: "logarithmic_opinion_pool" as const,
        calibrationMethod: "identity" as const,
        uncertaintyMethod: "bootstrap" as const,
        weightRegime: "cold_start" as const,
        replayFidelity: "exact" as const,
        conflicts: [],
        missingEvidence: [],
        citations: [
          {
            title: evidence[0]!.title,
            url: evidence[0]!.url,
            sourceFamily: evidence[0]!.sourceFamily,
          },
        ],
        modelVersion: "judge-v1",
        weightVersion: calibrationSnapshot.id,
        calibrationVersion: calibrationSnapshot.id,
        status: "completed" as const,
        cacheEvents: [],
      })),
    };

    const first = await evaluateEventForecast({
      env: createFixtureEnv({
        CASSANDRA_ADAPTER_MODE: "live",
      }),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence,
      calibrationSnapshot,
      judgeCacheStore,
      judgeClient,
    });

    const second = await evaluateEventForecast({
      env: createFixtureEnv({
        CASSANDRA_ADAPTER_MODE: "live",
      }),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence,
      calibrationSnapshot,
      judgeCacheStore,
      judgeClient,
    });

    expect(judgeClient.judge).toHaveBeenCalledTimes(1);
    expect(first.judgeOpinions).toEqual(second.judgeOpinions);
    expect(second.cacheEvents).toContainEqual({
      layer: "judge_output",
      target: "panel",
      status: "hit",
    });
  });

  it("bypasses the judge cache in fixture mode", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const calibrationSnapshot = buildCalibrationSnapshot();
    const evidence = [buildEvidenceItem()];
    const judgeClient = {
      judge: vi.fn(async () => ({
        id: randomUUID(),
        eventId: event.id,
        evaluationTime: "2026-10-11T12:00:00Z",
        referenceClass: event.referenceClass,
        referenceClassFallback: null,
        priorProbability: 0.5,
        rawPosteriorProbability: 0.62,
        finalProbability: 0.6,
        confidenceLow: 0.5,
        confidenceHigh: 0.7,
        dependencyMatrix: [],
        disagreementShrinkage: 0.02,
        judgeOpinions: [
          {
            judgeName: "open_web_research",
            probability: 0.6,
            confidence: 0.7,
            evidenceStrength: "weak_for" as const,
            rationale: "Web evidence points slightly positive.",
            evidenceIds: [evidence[0]!.id],
            warnings: [],
            logBayesFactor: 0.5,
            baseWeight: 0.4,
            dependencyDiscount: 1,
            freshnessDecay: 1,
            effectiveLogOddsContribution: 0.2,
            missingEvidence: [],
          },
        ],
        weightBreakdown: [],
        ensembleMethod: "logarithmic_opinion_pool" as const,
        calibrationMethod: "identity" as const,
        uncertaintyMethod: "bootstrap" as const,
        weightRegime: "cold_start" as const,
        replayFidelity: "exact" as const,
        conflicts: [],
        missingEvidence: [],
        citations: [
          {
            title: evidence[0]!.title,
            url: evidence[0]!.url,
            sourceFamily: evidence[0]!.sourceFamily,
          },
        ],
        modelVersion: "judge-v1",
        weightVersion: calibrationSnapshot.id,
        calibrationVersion: calibrationSnapshot.id,
        status: "completed" as const,
        cacheEvents: [],
      })),
    };

    await evaluateEventForecast({
      env: createFixtureEnv(),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence,
      calibrationSnapshot,
      judgeClient,
    });

    const second = await evaluateEventForecast({
      env: createFixtureEnv(),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence,
      calibrationSnapshot,
      judgeClient,
    });

    expect(judgeClient.judge).toHaveBeenCalledTimes(2);
    expect(second.cacheEvents).toContainEqual({
      layer: "judge_output",
      target: "panel",
      status: "bypass",
    });
  });

  it("marks the queued run as failed when processing cannot complete", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const queued = await createJudgmentRun(pool, event.id);

    await expect(
      runJudgment({
        pool,
        env: createFixtureEnv({
          CASSANDRA_ADAPTER_MODE: "live",
        }),
        input: {
          judgmentId: queued.id,
          eventId: event.id,
          evaluationTime: "2026-10-11T12:00:00Z",
        },
        evidenceProviders: [
          {
            name: "live-provider",
            async collect() {
              return [
                buildEvidenceItem({
                  eventId: event.id,
                  sourceFamily: "official",
                  sourceType: "press_release",
                  title: "Official launch update",
                }),
                buildEvidenceItem({
                  eventId: event.id,
                  sourceFamily: "community",
                  sourceType: "reddit_post",
                  title: "Community launch thread",
                }),
                buildEvidenceItem({
                  eventId: event.id,
                  sourceFamily: "web",
                  title: "Independent launch report",
                }),
              ];
            },
          },
        ],
        judgeClient: {
          async judge() {
            throw new Error("judge service unavailable");
          },
        },
      }),
    ).rejects.toThrow("judge service unavailable");

    const stored = await getJudgmentById(pool, queued.id);

    expect(stored?.status).toBe("failed");
  });

  it("registers all live evidence families in the default provider list", () => {
    const providers = createDefaultEvidenceProviders(
      createFixtureEnv({
        CASSANDRA_ADAPTER_MODE: "live",
        ZAI_API_KEY: "zai-key",
      }),
    );

    expect(providers.map((provider) => provider.name)).toEqual([
      "officialSearch",
      "governmentSearch",
      "communitySearch",
      "web",
      "perplexity",
      "marketProvider",
      "polymarketGamma",
      "polymarketClob",
    ]);
  });

  it("marks live judgments as insufficient_evidence when citation coverage is too weak", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const queued = await createJudgmentRun(pool, event.id);
    const judgeSpy = vi.fn();

    const stored = await runJudgment({
      pool,
      env: createFixtureEnv({
        CASSANDRA_ADAPTER_MODE: "live",
      }),
      input: {
        judgmentId: queued.id,
        eventId: event.id,
        evaluationTime: "2026-10-11T12:00:00Z",
      },
      evidenceProviders: [
        {
          name: "marketProvider",
          async collect() {
            return [
              buildEvidenceItem({
                eventId: event.id,
                sourceFamily: "market",
                sourceType: "quote_snapshot",
                title: "Example market snapshot",
                url: "https://markets.example.com/example-corp",
              }),
            ];
          },
        },
      ],
      judgeClient: {
        judge: judgeSpy,
      } as never,
    });

    expect(judgeSpy).not.toHaveBeenCalled();
    expect(stored.status).toBe("insufficient_evidence");
    expect(stored.verdictTrace).toMatchObject({
      eventId: event.id,
      status: "insufficient_evidence",
    });
    expect(stored.verdictTrace?.missingEvidence.map((entry) => entry.sourceFamily)).toEqual(
      expect.arrayContaining(["official", "community", "web"]),
    );
  });

  it("rejects live judge traces that use placeholder citations", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const calibrationSnapshot = buildCalibrationSnapshot();
    const evidence = [
      buildEvidenceItem({
        eventId: event.id,
        sourceFamily: "official",
        sourceType: "press_release",
      }),
      buildEvidenceItem({
        eventId: event.id,
        sourceFamily: "community",
        sourceType: "reddit_post",
      }),
      buildEvidenceItem({
        eventId: event.id,
        sourceFamily: "web",
      }),
    ];

    await expect(
      evaluateEventForecast({
        env: createFixtureEnv({
          CASSANDRA_ADAPTER_MODE: "live",
        }),
        event,
        evaluationTime: "2026-10-11T12:00:00Z",
        evidence,
        calibrationSnapshot,
        judgeClient: {
          async judge() {
            return {
              id: randomUUID(),
              eventId: event.id,
              evaluationTime: "2026-10-11T12:00:00Z",
              referenceClass: event.referenceClass,
              referenceClassFallback: null,
              priorProbability: 0.5,
              rawPosteriorProbability: 0.62,
              finalProbability: 0.6,
              confidenceLow: 0.5,
              confidenceHigh: 0.7,
              dependencyMatrix: [],
              disagreementShrinkage: 0.02,
              judgeOpinions: [
                {
                  judgeName: "official_records",
                  probability: 0.6,
                  confidence: 0.7,
                  evidenceStrength: "weak_for" as const,
                  rationale: "Official evidence tilts positive.",
                  evidenceIds: [evidence[0]!.id],
                  warnings: [],
                  logBayesFactor: 0.5,
                  baseWeight: 0.4,
                  dependencyDiscount: 1,
                  freshnessDecay: 1,
                  effectiveLogOddsContribution: 0.2,
                  missingEvidence: [],
                },
              ],
              weightBreakdown: [
                {
                  source: "official_records",
                  weight: 0.4,
                  details: {},
                },
              ],
              ensembleMethod: "logarithmic_opinion_pool" as const,
              calibrationMethod: "identity" as const,
              uncertaintyMethod: "bootstrap" as const,
              weightRegime: "cold_start" as const,
              replayFidelity: "exact" as const,
              conflicts: [],
              missingEvidence: [],
              citations: [
                {
                  title: "Placeholder",
                  url: "https://example.invalid/no-evidence",
                  sourceFamily: "web" as const,
                },
              ],
              modelVersion: "judge-v1",
              weightVersion: calibrationSnapshot.id,
              calibrationVersion: calibrationSnapshot.id,
              status: "completed" as const,
              cacheEvents: [],
            };
          },
        },
      }),
    ).rejects.toThrow("placeholder");
  });
});
