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

describe("watchlist routes", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates watchlists and returns an empty candidate list by default", async () => {
    const app = buildApp({
      dbPool: pool,
    });

    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/watchlists",
        payload: {
          name: "Biotech approvals",
          keywords: ["FDA", "approval"],
          jurisdictions: ["US"],
          cadence: "daily",
          sourceToggles: {
            official: true,
            government: true,
          },
        },
      });

      expect(createResponse.statusCode).toBe(201);

      const created = createResponse.json();

      const listResponse = await app.inject({
        method: "GET",
        url: "/watchlists",
      });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toHaveLength(1);

      const candidatesResponse = await app.inject({
        method: "GET",
        url: `/watchlists/${created.id}/candidates`,
      });

      expect(candidatesResponse.statusCode).toBe(200);
      expect(candidatesResponse.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
