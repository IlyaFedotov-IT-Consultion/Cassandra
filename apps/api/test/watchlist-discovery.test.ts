import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { EvidenceItem } from "@cassandra/shared";

import { createDbPool } from "../src/lib/db.js";
import { clusterCandidateEvidence } from "../src/modules/watchlists/cluster.js";
import { discoverWatchlistCandidates } from "../src/modules/watchlists/discovery.js";
import { runWatchlistDiscoveryWorker } from "../src/workers/watchlistWorker.js";
import {
  createWatchlist,
  listCandidateEventsForWatchlist,
} from "../src/modules/watchlists/repository.js";

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

function buildEvidenceItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: randomUUID(),
    eventId: "watchlist-1",
    sourceFamily: "web",
    sourceType: "web_article",
    title: "Example Corp prepares Product X launch",
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
    ...overrides,
  };
}

describe("clusterCandidateEvidence", () => {
  it("clusters similar launch headlines into one candidate but keeps distinct claims separate", () => {
    const clusters = clusterCandidateEvidence([
      buildEvidenceItem({
        title: "Example Corp prepares Product X launch",
      }),
      buildEvidenceItem({
        title: "Reports say Example Corp is preparing Product X launch",
      }),
      buildEvidenceItem({
        title: "Regulator delays decision on Therapy Y",
        summary: "Therapy Y approval may slip into next quarter.",
        claims: ["Therapy Y decision is delayed"],
        entities: ["Therapy Y"],
      }),
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.supportingEvidenceIds.length).toBe(2);
    expect(clusters[1]?.supportingEvidenceIds.length).toBe(1);
  });
});

describe("watchlist discovery", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("discovers candidates and preserves manual promotion status across reruns", async () => {
    const watchlist = await createWatchlist(pool, {
      name: "Product launches",
      keywords: ["product launch", "Example Corp"],
      jurisdictions: [],
      cadence: "daily",
      sourceToggles: {},
    });

    const provider = {
      name: "fixtureWatchlistProvider",
      async collect() {
        return [
          buildEvidenceItem({
            eventId: watchlist.id,
            title: "Example Corp prepares Product X launch",
          }),
          buildEvidenceItem({
            eventId: watchlist.id,
            title: "Reports say Example Corp is preparing Product X launch",
          }),
        ];
      },
    };

    const initial = await discoverWatchlistCandidates({
      pool,
      watchlist,
      providers: [provider],
      evaluationTime: "2026-10-11T12:00:00Z",
      mode: "fixture",
    });

    expect(initial).toHaveLength(1);
    expect(initial[0]?.promotionStatus).toBe("pending");

    await pool.query(`UPDATE candidate_events SET promotion_status = 'promoted' WHERE id = $1`, [
      initial[0]?.id,
    ]);

    const rerun = await runWatchlistDiscoveryWorker({
      pool,
      watchlist,
      providers: [provider],
      evaluationTime: "2026-10-11T13:00:00Z",
      mode: "fixture",
    });

    expect(rerun).toHaveLength(1);

    const stored = await listCandidateEventsForWatchlist(pool, watchlist.id);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.promotionStatus).toBe("promoted");
    expect(stored[0]?.supportingEvidenceIds).toHaveLength(2);
  });
});
