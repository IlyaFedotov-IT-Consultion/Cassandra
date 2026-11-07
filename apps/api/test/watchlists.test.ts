import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WatchlistDiscoveryResultSchema, type EvidenceItem } from "@cassandra/shared";

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

      const detailResponse = await app.inject({
        method: "GET",
        url: `/watchlists/${created.id}`,
      });

      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json()).toMatchObject({
        id: created.id,
        name: "Biotech approvals",
      });

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

  it("returns 404 when a requested watchlist does not exist", async () => {
    const app = buildApp({
      dbPool: pool,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/watchlists/00000000-0000-0000-0000-000000000000",
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "Watchlist not found",
      });
    } finally {
      await app.close();
    }
  });

  it("runs discovery on demand and reports providers that failed without losing the rest", async () => {
    const evidence = (title: string): EvidenceItem => ({
      id: randomUUID(),
      sourceFamily: "web",
      sourceType: "web_article",
      title,
      url: `https://example.com/${randomUUID()}`,
      publisher: "Example News",
      publishedAt: "2026-10-10T09:00:00Z",
      retrievedAt: "2026-10-10T10:00:00Z",
      summary: "Example Corp appears close to launching Product X.",
      rawText: null,
      entities: ["Example Corp", "Product X"],
      claims: ["Example Corp may launch Product X soon"],
      stance: "supports",
      qualitySignals: {},
      metadata: {},
    });
    const app = buildApp({
      dbPool: pool,
      watchlistEvidenceProviders: [
        {
          name: "fixtureNews",
          async collect() {
            return [
              evidence("Example Corp prepares Product X launch"),
              evidence("Reports say Example Corp is preparing Product X launch"),
            ];
          },
        },
        {
          name: "polymarketGamma",
          async collect() {
            throw new Error("request timed out");
          },
        },
      ],
    });

    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/watchlists",
          payload: {
            name: "Product launches",
            keywords: ["product launch", "Example Corp"],
            jurisdictions: [],
            cadence: "daily",
            sourceToggles: {},
          },
        })
      ).json();

      const discoverResponse = await app.inject({
        method: "POST",
        url: `/watchlists/${created.id}/discover`,
      });

      expect(discoverResponse.statusCode).toBe(200);
      const result = WatchlistDiscoveryResultSchema.parse(discoverResponse.json());
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ watchlistId: created.id, promotionStatus: "pending" });
      expect(result.failedProviders).toEqual([{ providerName: "polymarketGamma", error: "request timed out" }]);

      const stored = await app.inject({ method: "GET", url: `/watchlists/${created.id}/candidates` });
      expect(stored.json()).toHaveLength(1);

      const detail = (await app.inject({ method: "GET", url: `/watchlists/${created.id}` })).json();
      expect(detail.lastDiscovery).toMatchObject({
        trigger: "manual",
        candidateCount: 1,
        failedProviders: [{ providerName: "polymarketGamma", error: "request timed out" }],
      });

      const missing = await app.inject({
        method: "POST",
        url: "/watchlists/00000000-0000-0000-0000-000000000000/discover",
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("keeps each watchlist's discovery schedule in step with its cadence", async () => {
    const synced: Array<{ id: string; cadence: string }> = [];
    const app = buildApp({
      dbPool: pool,
      watchlistDiscoveryScheduler: {
        async sync(watchlist) {
          synced.push({ id: watchlist.id, cadence: watchlist.cadence });
        },
        async describe(watchlist) {
          return { cadence: watchlist.cadence, intervalMs: 86_400_000, nextRunAt: "2026-11-08T09:00:00.000Z" };
        },
        async remove() {},
        async close() {},
      },
    });
    const unscheduledApp = buildApp({ dbPool: pool });

    try {
      const created = (
        await app.inject({
          method: "POST",
          url: "/watchlists",
          payload: { name: "Fed decisions", keywords: ["FOMC"], jurisdictions: [], cadence: "daily", sourceToggles: {} },
        })
      ).json();

      expect(synced).toEqual([{ id: created.id, cadence: "daily" }]);

      const schedule = await app.inject({ method: "GET", url: `/watchlists/${created.id}/schedule` });
      expect(schedule.statusCode).toBe(200);
      expect(schedule.json()).toEqual({ cadence: "daily", intervalMs: 86_400_000, nextRunAt: "2026-11-08T09:00:00.000Z" });

      // Without a scheduler (e.g. scheduling switched off) the cadence is still described, with no next run.
      const unscheduled = await unscheduledApp.inject({ method: "GET", url: `/watchlists/${created.id}/schedule` });
      expect(unscheduled.json()).toEqual({ cadence: "daily", intervalMs: 86_400_000, nextRunAt: null });

      const missing = await app.inject({
        method: "GET",
        url: "/watchlists/00000000-0000-0000-0000-000000000000/schedule",
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
      await unscheduledApp.close();
    }
  });
});
