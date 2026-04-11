import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";
import { createDbPool } from "../src/lib/db.js";
import { createEvent } from "../src/modules/events/repository.js";

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

describe("judgment routes", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates and fetches a completed judgment trace in fixture mode", async () => {
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
      env: getEnv({
        DATABASE_URL,
        REDIS_URL: "redis://localhost:6379",
        CASSANDRA_ADAPTER_MODE: "fixture",
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

      expect(createResponse.statusCode).toBe(201);

      const created = createResponse.json();

      expect(created).toMatchObject({
        eventId: event.id,
        status: "completed",
        verdictTrace: expect.objectContaining({
          eventId: event.id,
          status: "completed",
          weightRegime: "cold_start",
          citations: expect.any(Array),
          judgeOpinions: expect.any(Array),
        }),
        judgeOpinions: expect.any(Array),
      });

      expect(created.verdictTrace.citations.length).toBeGreaterThan(0);
      expect(created.judgeOpinions.length).toBeGreaterThan(0);

      const fetchResponse = await app.inject({
        method: "GET",
        url: `/judgments/${created.id}`,
      });

      expect(fetchResponse.statusCode).toBe(200);
      expect(fetchResponse.json()).toMatchObject({
        id: created.id,
        status: "completed",
      });
    } finally {
      await app.close();
    }
  });
});
