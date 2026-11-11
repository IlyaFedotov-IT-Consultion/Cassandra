import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createDbPool } from "../src/lib/db.js";
import { getEnv } from "../src/config/env.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra";

const pool = createDbPool(DATABASE_URL);

function createEnv(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return getEnv({
    DATABASE_URL,
    REDIS_URL: "redis://localhost:6379",
    ZAI_API_KEY: "zai-key",
    ...overrides,
  });
}

describe("research routes", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("runs and returns a research dossier", async () => {
    const app = buildApp({
      dbPool: pool,
      env: createEnv(),
      runResearch: async (input) => ({
        count: input.count,
        createdAt: "2026-10-11T12:00:00Z",
        domains: input.domains ?? [],
        id: "research-1",
        query: input.query,
        recency: input.recency ?? "noLimit",
        results: [
          {
            publishedAt: "2026-10-10T00:00:00Z",
            publisher: "example.com",
            summary: "Example result summary",
            title: "Example result",
            url: "https://example.com/result",
          },
        ],
        status: "completed" as const,
        summary: "Example result summary",
      }),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/research/runs",
        payload: {
          count: 3,
          domains: ["example.com"],
          query: "latest Example Corp launch research",
          recency: "oneMonth",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        id: "research-1",
        query: "latest Example Corp launch research",
        status: "completed",
      });
    } finally {
      await app.close();
    }
  });

  it("returns a stored research dossier by id", async () => {
    const app = buildApp({
      dbPool: pool,
      env: createEnv(),
      runResearch: async () => ({
        count: 5,
        createdAt: "2026-10-11T12:00:00Z",
        domains: [],
        id: "research-lookup",
        query: "query",
        recency: "noLimit",
        results: [],
        status: "completed" as const,
        summary: "",
      }),
    });

    try {
      await app.inject({
        method: "POST",
        url: "/research/runs",
        payload: {
          query: "query",
        },
      });

      const response = await app.inject({
        method: "GET",
        url: "/research/runs/research-lookup",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: "research-lookup",
        status: "completed",
      });
    } finally {
      await app.close();
    }
  });

  it("keeps only the most recent research runs in memory", async () => {
    let sequence = 0;
    const app = buildApp({
      dbPool: pool,
      env: createEnv(),
      runResearch: async (input) => ({
        count: 1,
        createdAt: "2026-10-11T12:00:00Z",
        domains: [],
        id: `research-capped-${(sequence += 1)}`,
        query: input.query,
        recency: "noLimit" as const,
        results: [],
        status: "completed" as const,
        summary: "",
      }),
    });

    try {
      for (let run = 0; run < 201; run += 1) {
        await app.inject({ method: "POST", url: "/research/runs", payload: { query: `query ${run}` } });
      }

      expect((await app.inject({ method: "GET", url: "/research/runs/research-capped-1" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/research/runs/research-capped-2" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/research/runs/research-capped-201" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
