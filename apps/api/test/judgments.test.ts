import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalibrationSnapshot, EvidenceItem } from "@cassandra/shared";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";
import { createDbPool } from "../src/lib/db.js";
import { createLogger, type AppLogger } from "../src/lib/logger.js";
import type { JudgmentJobQueue } from "../src/modules/judgments/jobQueue.js";
import { createEvent } from "../src/modules/events/repository.js";
import { InMemoryJudgeCacheStore } from "../src/modules/judgments/judgeCache.js";
import {
  appendJudgmentExecutionLog,
  appendJudgmentTrace,
  createJudgmentRun,
  getJudgmentById,
  listJudgments,
} from "../src/modules/judgments/repository.js";
import {
  createDefaultEvidenceProviders,
  evaluateEventForecast,
  type JudgeClient,
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

/**
 * JSON.parse silently keeps the last of two equal keys, so scan the raw line for
 * top-level keys that appear more than once.
 */
function repeatedTopLevelKeys(line: string): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  let depth = 0;
  let index = 0;

  while (index < line.length) {
    const char = line[index];

    if (char === "\"") {
      let end = index + 1;
      while (end < line.length && line[end] !== "\"") {
        end += line[end] === "\\" ? 2 : 1;
      }
      const isKey = depth === 1 && line.slice(end + 1).trimStart().startsWith(":");
      if (isKey) {
        const key = line.slice(index + 1, end);
        if (seen.has(key)) {
          repeated.push(key);
        }
        seen.add(key);
      }
      index = end + 1;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
    index += 1;
  }

  return repeated;
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

function buildJudgeTrace(args: {
  eventId: string;
  referenceClass: string | null;
  evaluationTime: string;
  calibrationSnapshot: CalibrationSnapshot;
  evidence: EvidenceItem[];
  priorProbability?: number;
  rawPosteriorProbability?: number;
  finalProbability?: number;
  confidenceLow?: number;
  confidenceHigh?: number;
  calibrationMethod?: "identity" | "logistic" | "isotonic" | "beta";
  status?: "completed" | "insufficient_evidence";
  citedEvidence?: EvidenceItem[];
}) {
  const citedEvidence = args.citedEvidence ?? args.evidence;
  const primaryEvidence = citedEvidence[0];
  const finalProbability = args.finalProbability ?? (args.status === "insufficient_evidence" ? 0.5 : 0.64);
  const rawPosteriorProbability = args.rawPosteriorProbability ?? finalProbability;

  return {
    id: randomUUID(),
    eventId: args.eventId,
    evaluationTime: args.evaluationTime,
    referenceClass: args.referenceClass,
    referenceClassFallback: null,
    priorProbability: args.priorProbability ?? 0.5,
    rawPosteriorProbability,
    finalProbability,
    confidenceLow: args.confidenceLow ?? Math.max(0, finalProbability - 0.1),
    confidenceHigh: args.confidenceHigh ?? Math.min(1, finalProbability + 0.1),
    dependencyMatrix: [],
    disagreementShrinkage: args.status === "insufficient_evidence" ? 0 : 0.04,
    judgeOpinions: [
      {
        judgeName: "official_records",
        probability: finalProbability,
        confidence: args.status === "insufficient_evidence" ? 0.55 : 0.8,
        evidenceStrength: args.status === "insufficient_evidence" ? "neutral" as const : "moderate_for" as const,
        rationale:
          args.status === "insufficient_evidence"
            ? "Evidence remains inconclusive."
            : "Evidence supports the forecast.",
        evidenceIds: primaryEvidence ? citedEvidence.map((item) => item.id) : [],
        warnings: [],
        logBayesFactor: args.status === "insufficient_evidence" ? 0 : 1.5,
        baseWeight: 0.4,
        dependencyDiscount: 1,
        freshnessDecay: 1,
        effectiveLogOddsContribution: args.status === "insufficient_evidence" ? 0 : 0.6,
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
    calibrationMethod: args.calibrationMethod ?? "identity" as const,
    uncertaintyMethod: "bootstrap" as const,
    weightRegime: args.calibrationSnapshot.weightRegime,
    replayFidelity: args.status === "insufficient_evidence" ? "approximate" as const : "exact" as const,
    conflicts: [],
    missingEvidence: [],
    citations:
      citedEvidence.length > 0
        ? citedEvidence.map((item) => ({
            title: item.title,
            url: item.url,
            sourceFamily: item.sourceFamily,
          }))
        : [
            {
              title: "No evidence",
              url: "https://example.com/no-evidence",
              sourceFamily: "web" as const,
            },
          ],
    modelVersion: "judge-v1",
    weightVersion: args.calibrationSnapshot.id,
    calibrationVersion: args.calibrationSnapshot.id,
    status: args.status ?? "completed" as const,
    cacheEvents: [],
  };
}

function createFixtureJudgeClient(overrides: {
  buildTrace?: (input: Parameters<JudgeClient["judge"]>[0]) => ReturnType<typeof buildJudgeTrace>;
} = {}): JudgeClient {
  return {
    async judge(input) {
      return (
        overrides.buildTrace?.(input) ??
        buildJudgeTrace({
          eventId: input.event.id,
          referenceClass: input.event.referenceClass,
          evaluationTime: input.evaluationTime,
          calibrationSnapshot: input.calibrationSnapshot,
          evidence: input.evidence,
        })
      );
    },
  };
}

function createImmediateJudgmentQueue(args: {
  env: ReturnType<typeof createFixtureEnv>;
  judgeClient?: JudgeClient;
  logger?: AppLogger;
}): JudgmentJobQueue {
  return {
    enqueue: vi.fn(async (input) => {
      queueMicrotask(() => {
        void runJudgment({
          pool,
          env: args.env,
          input,
          judgeClient: args.judgeClient ?? createFixtureJudgeClient(),
          logger: args.logger?.child({
            eventId: input.eventId,
            judgmentId: input.judgmentId,
          }),
        }).catch(() => undefined);
      });
    }),
    close: async () => undefined,
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
    const hasTerminalPersistenceLog = judgment.executionLog.some(
      (entry: { stage: string; level: string }) =>
        entry.stage === "storage" || (entry.stage === "run" && entry.level === "error"),
    );

    if (
      (judgment.status === "completed" ||
        judgment.status === "insufficient_evidence" ||
        judgment.status === "failed") &&
      hasTerminalPersistenceLog
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
      judgmentQueue: createImmediateJudgmentQueue({
        env: createFixtureEnv(),
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

      expect(queued).toMatchObject({
        eventId: event.id,
        status: "queued",
      });

      const completed = await waitForCompletedJudgment(app, queued.id);

      expect(completed).toMatchObject({
        id: queued.id,
        eventId: event.id,
        status: "completed",
        executionLog: expect.arrayContaining([
          expect.objectContaining({
            stage: "queue",
            message: expect.stringMatching(/queued/i),
          }),
          expect.objectContaining({
            stage: "evidence",
            message: expect.stringMatching(/evidence collection finished/i),
          }),
          expect.objectContaining({
            stage: "storage",
            message: expect.stringMatching(/persisted/i),
          }),
        ]),
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

  it("enqueues judgment jobs through the configured queue abstraction", async () => {
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
    const judgmentQueue: JudgmentJobQueue = {
      enqueue: vi.fn(async () => undefined),
      close: async () => undefined,
    };
    const app = buildApp({
      dbPool: pool,
      env: createFixtureEnv(),
      judgmentQueue,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/judgments",
        payload: {
          eventId: event.id,
          evaluationTime: "2026-10-11T12:00:00Z",
        },
      });

      expect(response.statusCode).toBe(202);
      const payload = response.json();
      expect(judgmentQueue.enqueue).toHaveBeenCalledWith({
        judgmentId: payload.id,
        eventId: event.id,
        evaluationTime: "2026-10-11T12:00:00Z",
      });
    } finally {
      await app.close();
    }
  });

  it("lists only the newest judgments when given a limit, and rejects a bad one", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Official launch announcement.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const app = buildApp({
      dbPool: pool,
      env: createFixtureEnv(),
      judgmentQueue: { enqueue: async () => undefined, close: async () => undefined } as JudgmentJobQueue,
    });

    try {
      const created: string[] = [];
      for (let run = 0; run < 3; run += 1) {
        const response = await app.inject({ method: "POST", url: "/judgments", payload: { eventId: event.id } });
        created.push(response.json().id);
      }

      const limited = await app.inject({ method: "GET", url: "/judgments?limit=2" });
      const all = await app.inject({ method: "GET", url: "/judgments" });
      const invalid = await app.inject({ method: "GET", url: "/judgments?limit=0" });

      expect(limited.json().map((judgment: { id: string }) => judgment.id)).toEqual([created[2], created[1]]);
      expect(all.json()).toHaveLength(3);
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("fixes the evaluation time when the judgment is queued, so a retry reuses it", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Official launch announcement.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const enqueue = vi.fn(async (_input: { evaluationTime?: string }) => undefined);
    const app = buildApp({
      dbPool: pool,
      env: createFixtureEnv(),
      judgmentQueue: { enqueue, close: async () => undefined } as JudgmentJobQueue,
    });
    const before = Date.now();

    try {
      const response = await app.inject({ method: "POST", url: "/judgments", payload: { eventId: event.id } });

      expect(response.statusCode).toBe(202);
      const queuedAt = Date.parse(enqueue.mock.calls[0]?.[0]?.evaluationTime ?? "");
      expect(queuedAt).toBeGreaterThanOrEqual(before);
      expect(queuedAt).toBeLessThanOrEqual(Date.now());
    } finally {
      await app.close();
    }
  });

  it("rejects live judgments before queueing when no authoritative search providers are configured", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });

    const app = buildApp({
      dbPool: pool,
      env: getEnv({
        DATABASE_URL,
        REDIS_URL: "redis://localhost:6379",
        CASSANDRA_ADAPTER_MODE: "live",
      }),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/judgments",
        payload: {
          eventId: event.id,
          evaluationTime: "2026-10-11T12:00:00Z",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error:
          "Live judgments require at least one configured authoritative search provider. Set ZAI_API_KEY, OPENROUTER_API_KEY or PERPLEXITY_API_KEY, or switch to CASSANDRA_ADAPTER_MODE=fixture.",
      });
      expect(await listJudgments(pool)).toHaveLength(0);
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
      judgmentQueue: createImmediateJudgmentQueue({
        env: createFixtureEnv(),
        logger: createLogger({
          component: "test",
          destination,
          level: "info",
        }),
      }),
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

      expect(lines.some((line) => line.includes("\"event\":\"judgment_execution_log\""))).toBe(true);
      const linesWithRepeatedKeys = lines
        .map((line) => ({ line, repeated: repeatedTopLevelKeys(line) }))
        .filter((entry) => entry.repeated.length > 0);
      expect(linesWithRepeatedKeys).toEqual([]);
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
      judgeClient: createFixtureJudgeClient({
        buildTrace: (input) =>
          buildJudgeTrace({
            eventId: input.event.id,
            referenceClass: input.event.referenceClass,
            evaluationTime: input.evaluationTime,
            calibrationSnapshot: input.calibrationSnapshot,
            evidence: input.evidence,
            status: "insufficient_evidence",
            finalProbability: 0.5,
          }),
      }),
    });

    expect(completed.status).toBe("insufficient_evidence");
    expect(completed.verdictTrace?.status).toBe("insufficient_evidence");
    expect(completed.verdictTrace?.finalProbability).toBeGreaterThanOrEqual(0.4);
    expect(completed.verdictTrace?.finalProbability).toBeLessThanOrEqual(0.6);
    expect(completed.verdictTrace?.citations.length).toBeGreaterThan(0);
    expect(completed.executionLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "judge",
          level: "warn",
        }),
      ]),
    );
  });

  it("preserves blended prior probabilities returned by the judge service in fixture mode", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: ["EXMPL"],
      polymarketMarketId: "poly-1",
    });
    const evidence = [
      buildEvidenceItem({
        eventId: event.id,
        sourceFamily: "prediction_market",
        sourceType: "polymarket_market",
        title: "Polymarket launch market",
        stance: "neutral",
        metadata: {
          price: 0.72,
          spread: 0.02,
          depth: 500000,
          volatility: 0.04,
        },
      }),
      buildEvidenceItem({
        eventId: event.id,
        sourceFamily: "official",
        sourceType: "press_release",
        title: "Official launch note",
        stance: "supports",
      }),
    ];
    const calibrationSnapshot: CalibrationSnapshot = {
      ...buildCalibrationSnapshot(),
      baseRateParams: {
        minimumSample: 20,
        historicalCounts: {
          product_launch: {
            successes: 18,
            total: 20,
          },
        },
      },
      marketPriorParams: {
        defaultAlpha: 0.6,
      },
    };

    const trace = await evaluateEventForecast({
      env: createFixtureEnv(),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence,
      calibrationSnapshot,
      judgeClient: createFixtureJudgeClient({
        buildTrace: (input) =>
          buildJudgeTrace({
            eventId: input.event.id,
            referenceClass: input.event.referenceClass,
            evaluationTime: input.evaluationTime,
            calibrationSnapshot: input.calibrationSnapshot,
            evidence: input.evidence,
            priorProbability: 0.74,
            finalProbability: 0.69,
          }),
      }),
    });

    expect(trace.priorProbability).toBe(0.74);
  });

  it("preserves calibration metadata returned by the judge service in fixture mode", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const evidence = [
      buildEvidenceItem({
        eventId: event.id,
        sourceFamily: "official",
        sourceType: "press_release",
        title: "Official launch note",
        stance: "supports",
      }),
      buildEvidenceItem({
        eventId: event.id,
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Independent launch report",
        stance: "supports",
      }),
    ];
    const identityTrace = await evaluateEventForecast({
      env: createFixtureEnv(),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence,
      calibrationSnapshot: {
        ...buildCalibrationSnapshot(),
        calibrationParams: {
          method: "identity",
        },
      },
      judgeClient: createFixtureJudgeClient({
        buildTrace: (input) =>
          buildJudgeTrace({
            eventId: input.event.id,
            referenceClass: input.event.referenceClass,
            evaluationTime: input.evaluationTime,
            calibrationSnapshot: input.calibrationSnapshot,
            evidence: input.evidence,
            calibrationMethod: "identity",
            finalProbability: 0.68,
          }),
      }),
    });
    const logisticTrace = await evaluateEventForecast({
      env: createFixtureEnv(),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence,
      calibrationSnapshot: {
        ...buildCalibrationSnapshot(),
        calibrationParams: {
          method: "logistic",
          slope: 0.4,
          intercept: -1.2,
        },
      },
      judgeClient: createFixtureJudgeClient({
        buildTrace: (input) =>
          buildJudgeTrace({
            eventId: input.event.id,
            referenceClass: input.event.referenceClass,
            evaluationTime: input.evaluationTime,
            calibrationSnapshot: input.calibrationSnapshot,
            evidence: input.evidence,
            calibrationMethod: "logistic",
            finalProbability: 0.41,
          }),
      }),
    });

    expect(logisticTrace.calibrationMethod).toBe("logistic");
    expect(logisticTrace.finalProbability).not.toBe(identityTrace.finalProbability);
    expect(logisticTrace.finalProbability).toBeLessThan(identityTrace.finalProbability);
  });

  it("persists execution logs when a judgment run fails", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp secure approval by 2026-12-31?",
      resolutionCriteria: "Approval must be announced by the regulator.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: "regulatory_approval",
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
            name: "broken-provider",
            async collect() {
              throw new Error("upstream provider timeout");
            },
          },
        ],
      }),
    ).rejects.toThrow("All 1 evidence provider(s) failed in live mode");

    const stored = await getJudgmentById(pool, queued.id);

    expect(stored?.status).toBe("failed");
    expect(stored?.executionLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "run",
          level: "info",
          message: expect.stringMatching(/started/i),
        }),
        expect.objectContaining({
          stage: "run",
          level: "error",
          message: expect.stringMatching(/failed/i),
          details: expect.objectContaining({
            error: expect.stringMatching(/All 1 evidence provider\(s\) failed in live mode/i),
          }),
        }),
      ]),
    );
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

  it("returns filtered runtime events from the runtime route", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const judgment = await createJudgmentRun(pool, event.id);
    await appendJudgmentExecutionLog(pool, judgment.id, [
      {
        timestamp: "2026-01-01T00:00:00Z",
        level: "info",
        stage: "queue",
        message: "Judgment was queued for background processing.",
        details: {
          eventId: event.id,
        },
      },
      {
        timestamp: "2026-01-01T00:01:00Z",
        level: "warn",
        stage: "evidence",
        message: "Evidence collection finished with degraded provider coverage.",
        details: {
          failedProviders: ["web"],
        },
      },
    ]);

    const app = buildApp({
      dbPool: pool,
      env: createFixtureEnv(),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/runtime?stage=evidence&level=warn&search=degraded",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          judgmentId: judgment.id,
          eventId: event.id,
          judgmentStatus: "queued",
          entry: expect.objectContaining({
            stage: "evidence",
            level: "warn",
          }),
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

  it("uses the HTTP judge client in fixture mode instead of local TS aggregation", async () => {
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
    ];
    const trace = {
      id: randomUUID(),
      eventId: event.id,
      evaluationTime: "2026-10-11T12:00:00Z",
      referenceClass: event.referenceClass,
      referenceClassFallback: null,
      priorProbability: 0.61,
      rawPosteriorProbability: 0.7,
      finalProbability: 0.68,
      confidenceLow: 0.58,
      confidenceHigh: 0.78,
      dependencyMatrix: [],
      disagreementShrinkage: 0.04,
      judgeOpinions: [
        {
          judgeName: "official_records",
          probability: 0.68,
          confidence: 0.8,
          evidenceStrength: "moderate_for" as const,
          rationale: "Official evidence supports the launch.",
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
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(trace), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    try {
      const result = await evaluateEventForecast({
        env: createFixtureEnv({
          JUDGE_BASE_URL: "http://judge.local",
        }),
        event,
        evaluationTime: "2026-10-11T12:00:00Z",
        evidence,
        calibrationSnapshot,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.finalProbability).toBe(trace.finalProbability);
      expect(result.cacheEvents).toContainEqual({
        layer: "judge_output",
        target: "panel",
        status: "bypass",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the configured judge request timeout for live judge calls", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }

        signal.addEventListener(
          "abort",
          () => reject(new DOMException("This operation was aborted", "AbortError")),
          { once: true },
        );
      }),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    try {
      const event = await createEvent(pool, {
        question: "Will Example Corp launch Product X by 2026-12-31?",
        resolutionCriteria: "Launch must be publicly announced.",
        deadline: "2026-12-31T23:59:59Z",
        entities: ["Example Corp", "Product X"],
        referenceClass: "product_launch",
        marketSymbols: [],
      });
      const pending = evaluateEventForecast({
        env: createFixtureEnv({
          CASSANDRA_ADAPTER_MODE: "live",
          JUDGE_BASE_URL: "http://judge.local",
          JUDGE_REQUEST_TIMEOUT_MS: "50",
        }),
        event,
        evaluationTime: "2026-10-11T12:00:00Z",
        evidence: [
          buildEvidenceItem({
            eventId: event.id,
            sourceFamily: "official",
            sourceType: "press_release",
            title: "Official launch update",
          }),
        ],
        calibrationSnapshot: buildCalibrationSnapshot(),
        judgeCacheStore: new InMemoryJudgeCacheStore(),
      });
      const outcome = pending.then(
        () => null,
        (error) => error,
      );

      await vi.advanceTimersByTimeAsync(60);

      const error = await outcome;
      expect(error).toBeInstanceOf(DOMException);
      expect((error as Error).message).toContain("aborted");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
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
        PERPLEXITY_API_KEY: "perplexity-key",
        CUSTOM_MARKET_API_BASE_URL: "https://markets.example.com",
        CUSTOM_MARKET_API_KEY: "market-key",
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

  it("skips placeholder-backed live providers when credentials are not configured", () => {
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
    const judgeSpy = vi.fn(async (input: Parameters<JudgeClient["judge"]>[0]) =>
      buildJudgeTrace({
        eventId: input.event.id,
        referenceClass: input.event.referenceClass,
        evaluationTime: input.evaluationTime,
        calibrationSnapshot: input.calibrationSnapshot,
        evidence: input.evidence,
        status: "insufficient_evidence",
      }),
    );

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

    expect(judgeSpy).toHaveBeenCalledTimes(1);
    expect(judgeSpy.mock.calls[0]?.[0].priorOnly).toBe(true);
    expect(stored.status).toBe("insufficient_evidence");
    expect(stored.verdictTrace).toMatchObject({
      eventId: event.id,
      status: "insufficient_evidence",
    });
    expect(stored.verdictTrace?.missingEvidence.map((entry) => entry.sourceFamily)).toEqual(
      expect.arrayContaining(["official", "community", "web"]),
    );
  });

  it("plans sub-question queries before retrieval and records every pipeline stage", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const queued = await createJudgmentRun(pool, event.id);
    const receivedQueries: Array<string[] | undefined> = [];
    const judgeClient: JudgeClient = {
      ...createFixtureJudgeClient(),
      async plan() {
        return {
          subQuestions: ["Has Example Corp set a launch date?"],
          queries: ["Example Corp Product X launch date"],
          model: "utility-model",
        };
      },
    };

    const stored = await runJudgment({
      pool,
      env: createFixtureEnv(),
      input: { judgmentId: queued.id, eventId: event.id, evaluationTime: "2026-10-11T12:00:00Z" },
      evidenceProviders: [
        {
          name: "web",
          async collect(input) {
            receivedQueries.push(input.queries);
            return [buildEvidenceItem({ eventId: event.id })];
          },
        },
      ],
      judgeClient,
    });

    expect(receivedQueries).toEqual([["Example Corp Product X launch date"]]);
    expect(stored.verdictTrace?.pipelineStages.slice(0, 2)).toMatchObject([
      { stage: "query_planning", status: "completed", details: { queries: ["Example Corp Product X launch date"] } },
      { stage: "retrieval", status: "completed", details: { plannedQueries: 1, evidenceCount: 1 } },
    ]);
    expect(stored.executionLog.map((entry) => entry.stage)).toContain("planning");
  });

  it("fails live judgments when every evidence provider returns zero items", async () => {
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
            name: "officialSearch",
            async collect() {
              return [];
            },
          },
          {
            name: "web",
            async collect() {
              return [];
            },
          },
        ],
        judgeClient: {
          judge: judgeSpy,
        } as never,
      }),
    ).rejects.toThrow("returned zero evidence items");

    expect(judgeSpy).not.toHaveBeenCalled();

    const stored = await getJudgmentById(pool, queued.id);
    expect(stored?.status).toBe("failed");
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

  it("only includes citations for evidence referenced by the judge panel", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const calibrationSnapshot = buildCalibrationSnapshot();
    const officialEvidence = buildEvidenceItem({
      eventId: event.id,
      sourceFamily: "official",
      sourceType: "press_release",
      title: "Example Corp confirms launch preparation",
      url: "https://example.com/official-launch-prep",
    });
    const communityEvidence = buildEvidenceItem({
      eventId: event.id,
      sourceFamily: "community",
      sourceType: "reddit_post",
      title: "Community discusses launch schedule",
      url: "https://example.com/community-launch-thread",
    });
    const webEvidence = buildEvidenceItem({
      eventId: event.id,
      sourceFamily: "web",
      sourceType: "web_article",
      title: "Analysts expect Product X before year end",
      url: "https://example.com/analyst-launch-report",
    });
    const unusedMarketEvidence = buildEvidenceItem({
      eventId: event.id,
      sourceFamily: "market",
      sourceType: "market_odds",
      title: "Macro forecast for unrelated sector ETF flows",
      summary: "This market note covers shipping indexes and unrelated sector ETF flows.",
      entities: ["Sector ETF"],
      claims: ["ETF flows may rise this quarter"],
      url: "https://example.com/unrelated-market-note",
      metadata: {
        provider: "marketProvider",
      },
    });

    const trace = await evaluateEventForecast({
      env: createFixtureEnv(),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence: [
        officialEvidence,
        communityEvidence,
        webEvidence,
        unusedMarketEvidence,
      ],
      calibrationSnapshot,
      judgeClient: createFixtureJudgeClient({
        buildTrace: (input) =>
          buildJudgeTrace({
            eventId: input.event.id,
            referenceClass: input.event.referenceClass,
            evaluationTime: input.evaluationTime,
            calibrationSnapshot: input.calibrationSnapshot,
            evidence: input.evidence,
            citedEvidence: [officialEvidence, communityEvidence, webEvidence],
          }),
      }),
    });

    expect(trace.citations.map((citation) => citation.url)).toEqual([
      officialEvidence.url,
      communityEvidence.url,
      webEvidence.url,
    ]);
  });

  it("filters unrelated evidence before calling the judge service", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Launch must be publicly announced.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });
    const calibrationSnapshot = buildCalibrationSnapshot();
    const officialEvidence = buildEvidenceItem({
      eventId: event.id,
      sourceFamily: "official",
      sourceType: "press_release",
      title: "Example Corp confirms launch preparation",
      url: "https://example.com/official-launch-prep-2",
    });
    const communityEvidence = buildEvidenceItem({
      eventId: event.id,
      sourceFamily: "community",
      sourceType: "reddit_post",
      title: "Community discusses launch schedule",
      url: "https://example.com/community-launch-thread-2",
    });
    const webEvidence = buildEvidenceItem({
      eventId: event.id,
      sourceFamily: "web",
      sourceType: "web_article",
      title: "Analysts expect Product X before year end",
      url: "https://example.com/analyst-launch-report-2",
    });
    const unrelatedEvidence = buildEvidenceItem({
      eventId: event.id,
      sourceFamily: "prediction_market",
      sourceType: "polymarket_market",
      title: "Will Torino qualify for the League Phase of the 2026-27 UEFA Champions League?",
      summary: "Soccer market about Torino qualifying for the Champions League.",
      entities: ["Torino"],
      claims: ["Torino may qualify for the Champions League."],
      url: "https://polymarket.com/event/torino-qualify",
    });

    let capturedEvidence: EvidenceItem[] = [];

    await evaluateEventForecast({
      env: createFixtureEnv({
        CASSANDRA_ADAPTER_MODE: "live",
      }),
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      evidence: [
        officialEvidence,
        communityEvidence,
        webEvidence,
        unrelatedEvidence,
      ],
      calibrationSnapshot,
      judgeClient: {
        async judge(input) {
          capturedEvidence = input.evidence as EvidenceItem[];

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
                evidenceIds: [officialEvidence.id],
                warnings: [],
                logBayesFactor: 0.5,
                baseWeight: 0.4,
                dependencyDiscount: 1,
                freshnessDecay: 1,
                effectiveLogOddsContribution: 0.2,
                missingEvidence: [],
              },
              {
                judgeName: "community_signal",
                probability: 0.58,
                confidence: 0.68,
                evidenceStrength: "weak_for" as const,
                rationale: "Community evidence is directionally positive.",
                evidenceIds: [communityEvidence.id],
                warnings: [],
                logBayesFactor: 0.4,
                baseWeight: 0.2,
                dependencyDiscount: 1,
                freshnessDecay: 1,
                effectiveLogOddsContribution: 0.08,
                missingEvidence: [],
              },
              {
                judgeName: "open_web_research",
                probability: 0.61,
                confidence: 0.69,
                evidenceStrength: "weak_for" as const,
                rationale: "Web evidence supports the launch read.",
                evidenceIds: [webEvidence.id],
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
                title: officialEvidence.title,
                url: officialEvidence.url,
                sourceFamily: officialEvidence.sourceFamily,
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
    });

    expect(capturedEvidence.map((item) => item.id)).toEqual([
      officialEvidence.id,
      communityEvidence.id,
      webEvidence.id,
    ]);
  });
});
