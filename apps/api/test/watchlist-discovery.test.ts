import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { EvidenceItem } from "@cassandra/shared";

import { createDbPool } from "../src/lib/db.js";
import { clusterCandidateEvidence } from "../src/modules/watchlists/cluster.js";
import { discoverWatchlistCandidates } from "../src/modules/watchlists/discovery.js";
import { runWatchlistDiscoveryWorker } from "../src/workers/watchlistWorker.js";
import {
  createWatchlist,
  getWatchlistById,
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

  it("does not merge conflicting launch and delay narratives for the same entity", () => {
    const clusters = clusterCandidateEvidence([
      buildEvidenceItem({
        title: "Example Corp prepares Product X launch",
        claims: ["Example Corp may launch Product X soon"],
      }),
      buildEvidenceItem({
        title: "Example Corp delays Product X launch",
        summary: "The company pushed the launch into next quarter.",
        claims: ["Example Corp delayed Product X launch"],
        stance: "contradicts",
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });
});

function searchResult(title: string, overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  // What a live search result looks like: no entities, no claims, unknown stance.
  return buildEvidenceItem({ title, summary: title, entities: [], claims: [], stance: "unknown", ...overrides });
}

describe("clustering search results that carry no entities", () => {
  it("keeps unrelated stories apart", () => {
    const clusters = clusterCandidateEvidence([
      searchResult("Fed holds rates steady as inflation cools"),
      searchResult("Apple unveils new iPhone at September event"),
      searchResult("Senate passes annual defense spending bill"),
    ]);

    expect(clusters.map((cluster) => cluster.title).sort()).toEqual([
      "Apple unveils new iPhone at September event",
      "Fed holds rates steady as inflation cools",
      "Senate passes annual defense spending bill",
    ]);
  });

  it("groups differently worded headlines about one story", () => {
    const clusters = clusterCandidateEvidence([
      searchResult("Fed holds rates steady as inflation cools"),
      searchResult("Fed holds interest rates steady, signals patience on cuts"),
      searchResult("Apple unveils new iPhone at September event"),
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.supportingEvidenceIds).toHaveLength(2);
  });

  it("does not merge opposite developments in one story", () => {
    const clusters = clusterCandidateEvidence([
      searchResult("Regulator approves Therapy Y for adult patients"),
      searchResult("Regulator rejects Therapy Y for adult patients"),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("does not call two headlines one story because they share the watchlist's keywords", () => {
    const headlines = [searchResult("Fed interest rates decision"), searchResult("Fed interest rates outlook")];

    expect(clusterCandidateEvidence(headlines, { genericEntities: ["Fed", "interest rates"] })).toHaveLength(2);
    // Without knowing those words are shared by the whole watchlist, they look like one story.
    expect(clusterCandidateEvidence(headlines)).toHaveLength(1);
  });

  it("splits items by story when their only entities are the watchlist's own keywords", () => {
    const clusters = clusterCandidateEvidence(
      [
        searchResult("Will the Fed cut rates in December?", { entities: ["Fed"] }),
        searchResult("Will Fed chair Powell resign in 2026?", { entities: ["Fed"] }),
      ],
      { genericEntities: ["Fed", "interest rates"] },
    );

    expect(clusters).toHaveLength(2);
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

    const { candidates: initial } = await discoverWatchlistCandidates({
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

    const rerunOutcome = await runWatchlistDiscoveryWorker({
      pool,
      watchlistId: watchlist.id,
      providers: [provider],
      evaluationTime: "2026-10-11T13:00:00Z",
      mode: "fixture",
    });
    const rerun = rerunOutcome!.candidates;

    expect(rerun).toHaveLength(1);

    const stored = await listCandidateEventsForWatchlist(pool, watchlist.id);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.promotionStatus).toBe("promoted");
    expect(stored[0]?.supportingEvidenceIds).toHaveLength(2);
  });

  it("reuses the same candidate across reruns when wording changes but the event signature is the same", async () => {
    const watchlist = await createWatchlist(pool, {
      name: "Product launches",
      keywords: ["product launch", "Example Corp"],
      jurisdictions: [],
      cadence: "daily",
      sourceToggles: {},
    });

    const initialProvider = {
      name: "initialWatchlistProvider",
      async collect() {
        return [
          buildEvidenceItem({
            eventId: watchlist.id,
            title: "Example Corp prepares Product X launch",
            claims: ["Example Corp may launch Product X soon"],
          }),
        ];
      },
    };

    const rerunProvider = {
      name: "rerunWatchlistProvider",
      async collect() {
        return [
          buildEvidenceItem({
            eventId: watchlist.id,
            title: "Example Corp to debut Product X next month",
            summary: "The company is rolling out Product X soon.",
            claims: ["Example Corp will release Product X soon"],
          }),
        ];
      },
    };

    const { candidates: initial } = await discoverWatchlistCandidates({
      pool,
      watchlist,
      providers: [initialProvider],
      evaluationTime: "2026-10-11T12:00:00Z",
      mode: "fixture",
    });

    const rerunOutcome = await runWatchlistDiscoveryWorker({
      pool,
      watchlistId: watchlist.id,
      providers: [rerunProvider],
      evaluationTime: "2026-10-11T13:00:00Z",
      mode: "fixture",
    });
    const rerun = rerunOutcome!.candidates;

    expect(initial).toHaveLength(1);
    expect(rerun).toHaveLength(1);
    expect(rerun[0]?.id).toBe(initial[0]?.id);
    expect(rerun[0]?.clusterKey).toBe(initial[0]?.clusterKey);
    expect(rerun[0]?.candidateSignature).toMatchObject({
      action: "launch",
      polarity: "positive",
      entities: ["example corp", "product x"],
    });

    const stored = await listCandidateEventsForWatchlist(pool, watchlist.id);

    expect(stored).toHaveLength(1);
  });

  it("keeps one candidate per story across reruns of live search results, and adds new stories", async () => {
    const watchlist = await createWatchlist(pool, {
      name: "Central banks",
      keywords: ["Fed", "interest rates"],
      jurisdictions: [],
      cadence: "daily",
      sourceToggles: {},
    });
    const providerReturning = (titles: string[]) => ({
      name: "liveSearch",
      async collect() {
        return titles.map((title) => searchResult(title, { eventId: watchlist.id }));
      },
    });

    const { candidates: initial } = await discoverWatchlistCandidates({
      pool,
      watchlist,
      providers: [providerReturning(["Fed holds rates steady as inflation cools"])],
      evaluationTime: "2026-10-11T12:00:00Z",
      mode: "live",
    });
    const { candidates: rerun } = await discoverWatchlistCandidates({
      pool,
      watchlist,
      providers: [
        providerReturning([
          "Fed holds interest rates steady, signals patience on cuts",
          "Apple unveils new iPhone at September event",
        ]),
      ],
      evaluationTime: "2026-10-12T12:00:00Z",
      mode: "live",
    });

    expect(initial).toHaveLength(1);
    expect(rerun).toHaveLength(2);
    expect(rerun.map((candidate) => candidate.id)).toContain(initial[0]?.id);
    expect(await listCandidateEventsForWatchlist(pool, watchlist.id)).toHaveLength(2);
  });

  it("only asks the sources the watchlist has switched on", async () => {
    const watchlist = await createWatchlist(pool, {
      name: "Product launches",
      keywords: ["product launch", "Example Corp"],
      jurisdictions: [],
      cadence: "daily",
      sourceToggles: { official: true, community: false, predictionMarkets: false },
    });
    const asked: string[] = [];
    const provider = (name: string) => ({
      name,
      async collect() {
        asked.push(name);
        return [buildEvidenceItem({ eventId: watchlist.id, title: `Example Corp prepares Product X launch (${name})` })];
      },
    });

    await discoverWatchlistCandidates({
      pool,
      watchlist,
      providers: ["officialSearch", "communitySearch", "polymarketGamma", "polymarketClob", "governmentSearch", "web"].map(
        provider,
      ),
      evaluationTime: "2026-10-11T12:00:00Z",
      mode: "fixture",
    });

    // Switched off: community and prediction markets. Not mentioned (government) or untoggleable (web): still asked.
    expect(asked.sort()).toEqual(["governmentSearch", "officialSearch", "web"]);
  });

  it("records a scheduled run on the watchlist, including the sources that failed", async () => {
    const watchlist = await createWatchlist(pool, {
      name: "Product launches",
      keywords: ["product launch", "Example Corp"],
      jurisdictions: [],
      cadence: "daily",
      sourceToggles: {},
    });

    await runWatchlistDiscoveryWorker({
      pool,
      watchlistId: watchlist.id,
      providers: [
        {
          name: "web",
          async collect() {
            return [buildEvidenceItem({ eventId: watchlist.id, title: "Example Corp prepares Product X launch" })];
          },
        },
        {
          name: "polymarketGamma",
          async collect() {
            throw new Error("request timed out");
          },
        },
      ],
      evaluationTime: "2026-10-11T12:00:00Z",
      mode: "fixture",
    });

    expect((await getWatchlistById(pool, watchlist.id))?.lastDiscovery).toEqual({
      ranAt: "2026-10-11T12:00:00.000Z",
      trigger: "scheduled",
      candidateCount: 1,
      failedProviders: [{ providerName: "polymarketGamma", error: "request timed out" }],
    });
  });

  it("skips a scheduled run for a watchlist that no longer exists", async () => {
    const outcome = await runWatchlistDiscoveryWorker({
      pool,
      watchlistId: "00000000-0000-0000-0000-000000000000",
      providers: [],
      evaluationTime: "2026-10-11T12:00:00Z",
      mode: "fixture",
    });

    expect(outcome).toBeNull();
  });
});
