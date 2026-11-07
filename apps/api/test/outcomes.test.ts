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

describe("outcome and backtest routes", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records outcomes and retrains calibration with the active weight regime", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
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
        JUDGE_BASE_URL: "http://judge.local",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
    });

    try {
      const outcomeResponse = await app.inject({
        method: "POST",
        url: "/outcomes",
        payload: {
          eventId: event.id,
          resolvedValue: true,
          resolvedAt: "2026-12-31T23:59:59Z",
          resolutionSourceUrl: "https://example.com/resolution",
        },
      });

      expect(outcomeResponse.statusCode).toBe(201);

      const retrainResponse = await app.inject({
        method: "POST",
        url: "/backtests/retrain",
      });

      expect(retrainResponse.statusCode).toBe(201);
      expect(retrainResponse.json()).toMatchObject({
        resolvedOutcomeCount: 1,
        weightRegime: "cold_start",
      });
    } finally {
      await app.close();
    }
  });

  it("lists an event's outcomes newest first so a correction wins", async () => {
    const eventInput = {
      resolutionCriteria: "Counts only if the official source confirms it.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: "product_launch",
      marketSymbols: [],
    };
    const event = await createEvent(pool, { ...eventInput, question: "Will Example Corp ship by 2026-12-31?" });
    const otherEvent = await createEvent(pool, { ...eventInput, question: "Will Other Corp ship by 2026-12-31?" });
    const app = buildApp({ dbPool: pool });

    try {
      for (const payload of [
        { eventId: event.id, resolvedValue: true, resolutionSourceUrl: "https://example.com/first" },
        { eventId: otherEvent.id, resolvedValue: true, resolutionSourceUrl: "https://example.com/other" },
        { eventId: event.id, resolvedValue: false, resolutionSourceUrl: "https://example.com/correction" },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/outcomes",
          payload: { ...payload, resolvedAt: "2026-12-31T23:59:59Z" },
        });
        expect(response.statusCode).toBe(201);
      }

      const listResponse = await app.inject({ method: "GET", url: `/outcomes?eventId=${event.id}` });

      expect(listResponse.statusCode).toBe(200);
      const outcomes = listResponse.json();
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]).toMatchObject({
        eventId: event.id,
        resolvedValue: false,
        resolutionSourceUrl: "https://example.com/correction",
      });
      expect(outcomes[1]).toMatchObject({ resolutionSourceUrl: "https://example.com/first" });
      expect(Object.keys(outcomes[0]).sort()).toEqual(
        ["createdAt", "eventId", "id", "resolutionSourceUrl", "resolvedAt", "resolvedValue"],
      );

      const malformed = await app.inject({ method: "GET", url: "/outcomes?eventId=not-a-uuid" });
      expect(malformed.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
