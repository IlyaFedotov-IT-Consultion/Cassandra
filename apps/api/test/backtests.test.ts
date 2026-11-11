import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";

const verdictTrace = {
  id: "trace-1",
  eventId: "event-1",
  evaluationTime: "2026-10-11T12:00:00Z",
  referenceClass: "product_launch",
  referenceClassFallback: null,
  priorProbability: 0.5,
  rawPosteriorProbability: 0.62,
  finalProbability: 0.61,
  confidenceLow: 0.52,
  confidenceHigh: 0.69,
  dependencyMatrix: [],
  disagreementShrinkage: 0.05,
  judgeOpinions: [
    {
      judgeName: "official_records",
      probability: 0.66,
      confidence: 0.7,
      evidenceStrength: "weak_for",
      rationale: "Official evidence was mildly supportive.",
      evidenceIds: ["evidence-1"],
      warnings: [],
      logBayesFactor: 0.5,
      baseWeight: 0.33,
      dependencyDiscount: 1,
      freshnessDecay: 0.95,
      effectiveLogOddsContribution: 0.16,
      missingEvidence: [],
    },
  ],
  weightBreakdown: [
    {
      source: "official_records",
      weight: 0.33,
      details: {},
    },
  ],
  ensembleMethod: "logarithmic_opinion_pool",
  calibrationMethod: "identity",
  uncertaintyMethod: "bootstrap",
  weightRegime: "cold_start",
  replayFidelity: "exact",
  conflicts: [],
  missingEvidence: [],
  citations: [
    {
      title: "Example report",
      url: "https://example.com/report",
      sourceFamily: "web",
    },
  ],
  modelVersion: "judge-v1",
  weightVersion: "weights-v1",
  calibrationVersion: "cal-v1",
  status: "completed",
};

describe("backtest retrain route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads traces and outcomes, calls the judge service calibrate endpoint in live mode, and persists the returned snapshot", async () => {
    const capturedQueries: Array<{ text: string; params?: unknown[] }> = [];
    const pool = {
      async query(text: string, params?: unknown[]) {
        capturedQueries.push({ text, params });

        if (text.includes("FROM outcomes") && !text.includes("verdict_trace")) {
          return {
            rowCount: 1,
            rows: [
              {
                event_id: "event-1",
                resolved_value: true,
                resolved_at: new Date("2026-12-31T23:59:59Z"),
                resolution_source_url: "https://example.com/resolution",
              },
            ],
          };
        }

        if (text.includes("FROM outcomes") && text.includes("verdict_trace")) {
          return {
            rowCount: 1,
            rows: [
              {
                event_id: "event-1",
                resolved_value: true,
                resolved_at: new Date("2026-12-31T23:59:59Z"),
                resolution_source_url: "https://example.com/resolution",
                verdict_trace: verdictTrace,
              },
            ],
          };
        }

        if (text.includes("FROM benchmark_price_snapshots")) {
          return {
            rowCount: 1,
            rows: [{ probability: 0.7, resolved_value: true }],
          };
        }

        if (text.includes("INSERT INTO calibration_snapshots")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "db-snapshot-1",
                created_at: new Date("2026-01-02T00:00:00Z"),
                training_window: "all_time",
                judge_weights: { official_records: 0.5, community_signal: 0.25, open_web_research: 0.25 },
                base_rate_params: {},
                market_prior_params: {},
                calibration_params: { method: "logistic" },
                online_learning_params: { enabled: true, stepSizeScale: 0.5 },
                metrics: { traceCount: 1, outcomeCount: 1 },
                weight_regime: "warming",
                resolved_outcome_count: 1,
                approved: false,
              },
            ],
          };
        }

        throw new Error(`Unexpected query: ${text}`);
      },
    } as never;

    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");

      return new Response(
        JSON.stringify({
          id: "service-snapshot-1",
          createdAt: "2026-01-01T00:00:00Z",
          trainingWindow: "all_time",
          judgeWeights: {
            official_records: 0.5,
            community_signal: 0.25,
            open_web_research: 0.25,
          },
          baseRateParams: {},
          marketPriorParams: {},
          calibrationParams: { method: "logistic" },
          onlineLearningParams: { enabled: true, stepSizeScale: 0.5 },
          metrics: { traceCount: 1, outcomeCount: 1 },
          weightRegime: "warming",
          resolvedOutcomeCount: 1,
          approved: false,
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp({
      dbPool: pool,
      env: getEnv({
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra_test",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://judge.local",
        CASSANDRA_ADAPTER_MODE: "live",
      }),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/backtests/retrain",
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        id: "db-snapshot-1",
        weightRegime: "warming",
        resolvedOutcomeCount: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://judge.local/calibrate",
        expect.objectContaining({
          method: "POST",
        }),
      );

      const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(requestBody).toMatchObject({
        marketPricePairs: [{ price: 0.7, outcome: true }],
        historicalTraces: [expect.objectContaining({ id: "trace-1", eventId: "event-1" })],
        resolvedOutcomes: [
          expect.objectContaining({
            eventId: "event-1",
            resolvedValue: true,
            resolutionSourceUrl: "https://example.com/resolution",
          }),
        ],
      });

      expect(capturedQueries.some((entry) => entry.text.includes("INSERT INTO calibration_snapshots"))).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it("retries calibration locally in fixture mode without calling the judge service", async () => {
    const capturedQueries: Array<{ text: string; params?: unknown[] }> = [];
    const pool = {
      async query(text: string, params?: unknown[]) {
        capturedQueries.push({ text, params });

        if (text.includes("FROM outcomes") && !text.includes("verdict_trace")) {
          return {
            rowCount: 1,
            rows: [
              {
                event_id: "event-1",
                resolved_value: true,
                resolved_at: new Date("2026-12-31T23:59:59Z"),
                resolution_source_url: "https://example.com/resolution",
              },
            ],
          };
        }

        if (text.includes("FROM outcomes") && text.includes("verdict_trace")) {
          return {
            rowCount: 1,
            rows: [
              {
                event_id: "event-1",
                resolved_value: true,
                resolved_at: new Date("2026-12-31T23:59:59Z"),
                resolution_source_url: "https://example.com/resolution",
                verdict_trace: verdictTrace,
              },
            ],
          };
        }

        if (text.includes("FROM benchmark_price_snapshots")) {
          return { rowCount: 0, rows: [] };
        }

        if (text.includes("INSERT INTO calibration_snapshots")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "db-snapshot-2",
                created_at: new Date("2026-01-02T00:00:00Z"),
                training_window: "all_time",
                judge_weights: {
                  official_records: 1 / 3,
                  community_signal: 1 / 3,
                  open_web_research: 1 / 3,
                },
                base_rate_params: {},
                market_prior_params: {},
                calibration_params: { method: "identity" },
                online_learning_params: { enabled: false, stepSizeScale: 0 },
                metrics: {},
                weight_regime: "cold_start",
                resolved_outcome_count: 1,
                approved: false,
              },
            ],
          };
        }

        throw new Error(`Unexpected query: ${text}`);
      },
    } as never;

    const fetchMock = vi.fn(async () => {
      throw new Error("fixture mode should not call the judge service");
    });

    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp({
      dbPool: pool,
      env: getEnv({
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra_test",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://judge.local",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/backtests/retrain",
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        id: "db-snapshot-2",
        weightRegime: "cold_start",
        resolvedOutcomeCount: 1,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(capturedQueries.some((entry) => entry.text.includes("INSERT INTO calibration_snapshots"))).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it("lists calibration snapshots and fetches a snapshot by id", async () => {
    const pool = {
      async query(text: string, params?: unknown[]) {
        if (text.includes("FROM calibration_snapshots") && text.includes("ORDER BY approved DESC")) {
          return {
            rowCount: 2,
            rows: [
              {
                id: "snapshot-2",
                created_at: new Date("2026-01-03T00:00:00Z"),
                training_window: "rolling_90d",
                judge_weights: { official_records: 0.6 },
                base_rate_params: {},
                market_prior_params: {},
                calibration_params: { method: "isotonic" },
                online_learning_params: { enabled: true },
                metrics: { ece: 0.04 },
                weight_regime: "steady",
                resolved_outcome_count: 120,
                approved: true,
              },
              {
                id: "snapshot-1",
                created_at: new Date("2026-01-02T00:00:00Z"),
                training_window: "all_time",
                judge_weights: { official_records: 0.5 },
                base_rate_params: {},
                market_prior_params: {},
                calibration_params: { method: "logistic" },
                online_learning_params: { enabled: true },
                metrics: { ece: 0.08 },
                weight_regime: "warming",
                resolved_outcome_count: 25,
                approved: false,
              },
            ],
          };
        }

        if (text.includes("FROM calibration_snapshots") && Array.isArray(params) && params[0] === "snapshot-1") {
          return {
            rowCount: 1,
            rows: [
              {
                id: "snapshot-1",
                created_at: new Date("2026-01-02T00:00:00Z"),
                training_window: "all_time",
                judge_weights: { official_records: 0.5 },
                base_rate_params: {},
                market_prior_params: {},
                calibration_params: { method: "logistic" },
                online_learning_params: { enabled: true },
                metrics: { ece: 0.08 },
                weight_regime: "warming",
                resolved_outcome_count: 25,
                approved: false,
              },
            ],
          };
        }

        if (text.includes("FROM calibration_snapshots") && Array.isArray(params) && params[0] === "missing") {
          return {
            rowCount: 0,
            rows: [],
          };
        }

        throw new Error(`Unexpected query: ${text}`);
      },
    } as never;

    const app = buildApp({
      dbPool: pool,
      env: getEnv({
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra_test",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://judge.local",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
    });

    try {
      const listResponse = await app.inject({
        method: "GET",
        url: "/backtests/calibration-snapshots",
      });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toEqual([
        expect.objectContaining({
          id: "snapshot-2",
          weightRegime: "steady",
        }),
        expect.objectContaining({
          id: "snapshot-1",
          weightRegime: "warming",
        }),
      ]);

      const detailResponse = await app.inject({
        method: "GET",
        url: "/backtests/calibration-snapshots/snapshot-1",
      });

      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json()).toMatchObject({
        id: "snapshot-1",
        resolvedOutcomeCount: 25,
      });

      const missingResponse = await app.inject({
        method: "GET",
        url: "/backtests/calibration-snapshots/missing",
      });

      expect(missingResponse.statusCode).toBe(404);
      expect(missingResponse.json()).toEqual({
        error: "Calibration snapshot not found",
      });
    } finally {
      await app.close();
    }
  });

  it("approves a calibration snapshot and marks it as the preferred snapshot", async () => {
    const capturedQueries: Array<{ text: string; params?: unknown[] }> = [];
    const query = async (text: string, params?: unknown[]) => {
      capturedQueries.push({ text, params });

      if (text.trim() === "BEGIN" || text.trim() === "COMMIT" || text.trim() === "ROLLBACK") {
        return {
          rowCount: null,
          rows: [],
        };
      }

      const snapshotRow = {
        id: "snapshot-1",
        created_at: new Date("2026-01-02T00:00:00Z"),
        training_window: "all_time",
        judge_weights: { official_records: 0.5 },
        base_rate_params: {},
        market_prior_params: {},
        calibration_params: { method: "logistic" },
        online_learning_params: { enabled: true },
        metrics: { heldOut: { improves: true, brierIdentity: 0.3, brierCalibrated: 0.25 } },
        weight_regime: "warming",
        resolved_outcome_count: 25,
      };

      if (text.includes("FROM calibration_snapshots") && text.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [{ ...snapshotRow, approved: false }] };
      }

      if (text.includes("UPDATE calibration_snapshots") && text.includes("SET approved = TRUE")) {
        return { rowCount: 1, rows: [{ ...snapshotRow, approved: true }] };
      }

      if (text.includes("UPDATE calibration_snapshots") && text.includes("SET approved = FALSE")) {
        return {
          rowCount: 1,
          rows: [],
        };
      }

      throw new Error(`Unexpected query: ${text}`);
    };
    const pool = {
      query,
      async connect() {
        return {
          query,
          release() {},
        };
      },
    } as never;

    const app = buildApp({
      dbPool: pool,
      env: getEnv({
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra_test",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://judge.local",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/backtests/calibration-snapshots/snapshot-1/approve",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "snapshot-1",
        approved: true,
      });

      expect(
        capturedQueries.some((entry) => entry.text.includes("UPDATE calibration_snapshots") && entry.text.includes("SET approved = FALSE")),
      ).toBe(true);
      expect(
        capturedQueries.some((entry) => entry.text.includes("UPDATE calibration_snapshots") && entry.text.includes("SET approved = TRUE")),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
