import { afterAll, describe, expect, it } from "vitest";
import type { EvaluationRun } from "@cassandra/shared";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";

describe("evaluation routes", () => {
  afterAll(async () => {
    // no-op hook keeps parity with the DB-backed route suites
  });

  it("imports resolved Polymarket benchmarks through the evaluation route", async () => {
    const captured: unknown[][] = [];
    const pool = {
      async query(_text: string, params?: unknown[]) {
        captured.push(params ?? []);

        return {
          rows: [
            {
              id: "market-1",
              benchmark_set_id: "polymarket_recent_resolved",
              title: "Will Example Corp launch Product X by 2026-12-31?",
              resolution_criteria: "Official launch announcement by deadline.",
              theme: "technology",
              volume: 100000,
              liquidity: 25000,
              resolved_at: new Date("2026-12-31T23:59:59Z"),
              resolved_value: true,
              market_url: "https://polymarket.com/event/example-product-x",
            },
          ],
        };
      },
    } as never;

    const app = buildApp({
      dbPool: pool,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              id: "market-1",
              question: "Will Example Corp launch Product X by 2026-12-31?",
              resolution_criteria: "Official launch announcement by deadline.",
              end_date_iso: "2026-12-31T23:59:59Z",
              closed: true,
              archived: false,
              market_slug: "example-product-x",
              volume_num: 100000,
              liquidity_num: 25000,
              outcomes: ["Yes", "No"],
              outcome_prices: [1, 0],
              tags: [{ slug: "technology" }],
            },
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/benchmarks/import/polymarket",
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        imported: 1,
        markets: [
          expect.objectContaining({
            benchmarkSetId: "polymarket_recent_resolved",
            id: "market-1",
            theme: "technology",
          }),
        ],
      });
      expect(captured).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("imports resolved Polymarket benchmarks into an explicit benchmark set", async () => {
    const captured: unknown[][] = [];
    const pool = {
      async query(_text: string, params?: unknown[]) {
        captured.push(params ?? []);

        return {
          rows: [
            {
              id: "market-1",
              benchmark_set_id: "custom-benchmark-set",
              title: "Will Example Corp launch Product X by 2026-12-31?",
              resolution_criteria: "Official launch announcement by deadline.",
              theme: "technology",
              volume: 100000,
              liquidity: 25000,
              resolved_at: new Date("2026-12-31T23:59:59Z"),
              resolved_value: true,
              market_url: "https://polymarket.com/event/example-product-x",
            },
          ],
        };
      },
    } as never;

    const app = buildApp({
      dbPool: pool,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              id: "market-1",
              question: "Will Example Corp launch Product X by 2026-12-31?",
              resolution_criteria: "Official launch announcement by deadline.",
              end_date_iso: "2026-12-31T23:59:59Z",
              closed: true,
              archived: false,
              market_slug: "example-product-x",
              volume_num: 100000,
              liquidity_num: 25000,
              outcomes: ["Yes", "No"],
              outcome_prices: [1, 0],
              tags: [{ slug: "technology" }],
            },
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/benchmarks/import/polymarket",
        payload: {
          benchmarkSetId: "custom-benchmark-set",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        imported: 1,
        markets: [
          expect.objectContaining({
            benchmarkSetId: "custom-benchmark-set",
            id: "market-1",
          }),
        ],
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toContain("custom-benchmark-set");
    } finally {
      await app.close();
    }
  });

  it("rejects invalid benchmark import input", async () => {
    const app = buildApp({
      dbPool: {
        query: async () => ({ rows: [] }),
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/benchmarks/import/polymarket",
        payload: {
          benchmarkSetId: "",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Invalid benchmark import input",
        issues: expect.any(Array),
      });
    } finally {
      await app.close();
    }
  });

  it("returns 409 when an imported market already belongs to a different benchmark set", async () => {
    const query = async (_text: string, params?: unknown[]) => {
      if (Array.isArray(params) && params[0] === "market-1" && params.length === 1) {
        return {
          rows: [{ benchmark_set_id: "existing-benchmark-set" }],
        };
      }

      return {
        rows: [],
      };
    };

    const app = buildApp({
      dbPool: {
        query,
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              id: "market-1",
              question: "Will Example Corp launch Product X by 2026-12-31?",
              resolution_criteria: "Official launch announcement by deadline.",
              end_date_iso: "2026-12-31T23:59:59Z",
              closed: true,
              archived: false,
              market_slug: "example-product-x",
              volume_num: 100000,
              liquidity_num: 25000,
              outcomes: ["Yes", "No"],
              outcome_prices: [1, 0],
              tags: [{ slug: "technology" }],
            },
          ]),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/benchmarks/import/polymarket",
        payload: {
          benchmarkSetId: "custom-benchmark-set",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error:
          "Benchmark market market-1 already belongs to benchmark set existing-benchmark-set",
      });
    } finally {
      await app.close();
    }
  });

  it("creates evaluation runs through the evaluation route", async () => {
    const createdRun: EvaluationRun = {
      id: "run-1",
      benchmarkSetId: "benchmark-set-1",
      cutoffs: ["30d", "7d", "1d", "6h"],
      baselines: [
        "base_rate_only",
        "polymarket_only",
        "model_without_polymarket",
        "model_with_polymarket",
      ],
      overallMetrics: {
        benchmarkCount: 1,
        predictionCount: 16,
      },
      sliceResults: [],
      replayFidelity: "approximate",
      leakageWarnings: [],
      createdAt: "2026-01-02T00:00:00Z",
    };

    const app = buildApp({
      dbPool: {
        query: async () => ({ rows: [] }),
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      runEvaluation: async (input) => {
        expect(input).toEqual({
          benchmarkSetId: "benchmark-set-1",
        });
        return createdRun;
      },
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/runs",
        payload: {
          benchmarkSetId: "benchmark-set-1",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(createdRun);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid evaluation run input", async () => {
    const app = buildApp({
      dbPool: {
        query: async () => ({ rows: [] }),
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/runs",
        payload: {
          benchmarkSetId: "",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Invalid evaluation run input",
        issues: expect.any(Array),
      });
    } finally {
      await app.close();
    }
  });

  it("returns 404 when no benchmark markets are available for the requested evaluation run", async () => {
    const app = buildApp({
      dbPool: {
        query: async () => ({ rows: [] }),
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      runEvaluation: async () => {
        throw new Error("No benchmark markets available for evaluation");
      },
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/runs",
        payload: {
          benchmarkSetId: "benchmark-set-1",
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "No benchmark markets available for evaluation",
      });
    } finally {
      await app.close();
    }
  });

  it("returns 404 when requested benchmark market ids are missing", async () => {
    const app = buildApp({
      dbPool: {
        query: async () => ({ rows: [] }),
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      runEvaluation: async () => {
        throw new Error("Benchmark markets not found: missing-market");
      },
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/evaluation/runs",
        payload: {
          benchmarkSetId: "benchmark-set-1",
          benchmarkMarketIds: ["missing-market"],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "Benchmark markets not found: missing-market",
      });
    } finally {
      await app.close();
    }
  });

  it("fetches persisted evaluation runs through the evaluation route", async () => {
    const createdRun: EvaluationRun = {
      id: "run-1",
      benchmarkSetId: "benchmark-set-1",
      cutoffs: ["30d", "7d", "1d", "6h"],
      baselines: [
        "base_rate_only",
        "polymarket_only",
        "model_without_polymarket",
        "model_with_polymarket",
      ],
      overallMetrics: {
        benchmarkCount: 1,
        predictionCount: 16,
      },
      sliceResults: [],
      replayFidelity: "approximate",
      leakageWarnings: [],
      createdAt: "2026-01-02T00:00:00Z",
    };

    const app = buildApp({
      dbPool: {
        query: async () => ({ rows: [] }),
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        JUDGE_BASE_URL: "http://localhost:8000",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      getEvaluationRun: async (runId) => (runId === "run-1" ? createdRun : null),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/evaluation/runs/run-1",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(createdRun);

      const missing = await app.inject({
        method: "GET",
        url: "/evaluation/runs/missing-run",
      });

      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({
        error: "Evaluation run not found",
      });
    } finally {
      await app.close();
    }
  });
});
