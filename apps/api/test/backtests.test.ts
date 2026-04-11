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

  it("loads traces and outcomes, calls the judge service calibrate endpoint, and persists the returned snapshot", async () => {
    const capturedQueries: Array<{ text: string; params?: unknown[] }> = [];
    const pool = {
      async query(text: string, params?: unknown[]) {
        capturedQueries.push({ text, params });

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
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
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
});
