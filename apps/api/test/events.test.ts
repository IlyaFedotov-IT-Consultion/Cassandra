import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createDbPool } from "../src/lib/db.js";

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

describe("event routes", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates and fetches events including referenceClass", async () => {
    const app = buildApp({
      dbPool: pool,
    });

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/events",
        payload: {
          question: "Will Example Corp launch Product X by 2026-12-31?",
          resolutionCriteria:
            "Counts only if Example Corp posts a general availability announcement on its official site.",
          deadline: "2026-12-31T23:59:59Z",
          entities: ["Example Corp", "Product X"],
          referenceClass: "product_launch",
          marketSymbols: ["EXMPL"],
        },
      });

      expect(createResponse.statusCode).toBe(201);

      const created = createResponse.json();

      expect(created.referenceClass).toBe("product_launch");

      const fetchResponse = await app.inject({
        method: "GET",
        url: `/events/${created.id}`,
      });

      expect(fetchResponse.statusCode).toBe(200);
      expect(fetchResponse.json()).toMatchObject({
        id: created.id,
        referenceClass: "product_launch",
      });

      const listResponse = await app.inject({
        method: "GET",
        url: "/events",
      });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toHaveLength(1);
      expect(listResponse.json()[0]).toMatchObject({
        id: created.id,
      });
    } finally {
      await app.close();
    }
  });

  it("rejects invalid events missing resolution criteria or deadline", async () => {
    const app = buildApp({
      dbPool: pool,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/events",
        payload: {
          question: "Will Example Corp launch Product X?",
          resolutionCriteria: "",
          deadline: "",
          entities: ["Example Corp"],
        },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
