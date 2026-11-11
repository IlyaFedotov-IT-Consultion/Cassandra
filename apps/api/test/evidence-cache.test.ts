import { Writable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvidenceItem } from "@cassandra/shared";

import { createDbPool } from "../src/lib/db.js";
import { createLogger } from "../src/lib/logger.js";
import {
  InMemoryEvidenceCacheStore,
  collectEvidenceForEventWithCache,
} from "../src/modules/evidence/cache.js";
import { listEvidenceForEvent } from "../src/modules/evidence/repository.js";
import type { EvidenceProvider } from "../src/modules/evidence/types.js";
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

describe("collectEvidenceForEventWithCache", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("uses cached provider output in live mode and avoids a second provider call", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });

    let calls = 0;

    const provider: EvidenceProvider = {
      name: "cacheableProvider",
      async collect(input) {
        calls += 1;

        const item: EvidenceItem = {
          id: `11111111-1111-4111-8111-${String(calls).padStart(12, "0")}`,
          eventId: input.event.id,
          sourceFamily: "web",
          sourceType: "web_article",
          title: "Cached evidence item",
          url: "https://example.com/evidence?utm_source=test",
          publisher: "Example News",
          publishedAt: "2026-10-10T09:00:00Z",
          retrievedAt: "2026-10-10T10:00:00Z",
          summary: "Cached evidence summary",
          rawText: null,
          entities: ["Example Corp"],
          claims: ["Cached claim"],
          stance: "supports",
          qualitySignals: {},
          metadata: {},
        };

        return [item];
      },
    };

    const cacheStore = new InMemoryEvidenceCacheStore();

    const first = await collectEvidenceForEventWithCache({
      pool,
      event,
      evaluationTime: "2026-10-11T12:15:00Z",
      mode: "live",
      providers: [provider],
      cacheStore,
    });

    const second = await collectEvidenceForEventWithCache({
      pool,
      event,
      evaluationTime: "2026-10-11T12:45:00Z",
      mode: "live",
      providers: [provider],
      cacheStore,
    });

    expect(calls).toBe(1);
    expect(first.providerRuns[0]?.cacheStatus).toBe("miss");
    expect(second.providerRuns[0]?.cacheStatus).toBe("hit");

    const persisted = await listEvidenceForEvent(pool, event.id);
    expect(persisted).toHaveLength(1);
  });

  it("asks every provider at once and keeps their results in provider order", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria: "Official launch announcement.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp"],
      referenceClass: null,
      marketSymbols: [],
    });
    const item = (eventId: string, name: string): EvidenceItem => ({
      id: `22222222-2222-4222-8222-${name === "first" ? "000000000001" : "000000000002"}`,
      eventId,
      sourceFamily: "web",
      sourceType: "web_article",
      title: `${name} item`,
      url: `https://example.com/${name}`,
      publisher: "Example News",
      publishedAt: "2026-10-10T09:00:00Z",
      retrievedAt: "2026-10-10T10:00:00Z",
      summary: `${name} summary`,
      rawText: null,
      entities: [],
      claims: [],
      stance: "unknown",
      qualitySignals: {},
      metadata: {},
    });
    let announceSecondStarted: () => void = () => undefined;
    const secondStarted = new Promise<void>((resolve) => {
      announceSecondStarted = resolve;
    });
    const first: EvidenceProvider = {
      name: "first",
      async collect(input) {
        // Finishes only once the second provider is running.
        await Promise.race([
          secondStarted,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("the second provider was not started while the first was running")), 500),
          ),
        ]);
        return [item(input.event.id, "first")];
      },
    };
    const second: EvidenceProvider = {
      name: "second",
      async collect(input) {
        announceSecondStarted();
        return [item(input.event.id, "second")];
      },
    };

    const result = await collectEvidenceForEventWithCache({
      pool,
      event,
      evaluationTime: "2026-10-11T12:15:00Z",
      mode: "live",
      providers: [first, second],
      cacheStore: new InMemoryEvidenceCacheStore(),
    });

    expect(result.providerRuns.map((run) => [run.providerName, run.error ?? null])).toEqual([
      ["first", null],
      ["second", null],
    ]);
    expect(result.items.map((evidence) => evidence.title)).toEqual(["first item", "second item"]);
  });

  it("does not share cached provider output between events bound to different markets", async () => {
    const baseInput = {
      question: "Will no Fed rate cuts happen in 2026?",
      resolutionCriteria: "No FOMC cut during 2026.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Federal Reserve"],
      referenceClass: null,
      marketSymbols: [],
    };
    const first = await createEvent(pool, { ...baseInput, polymarketMarketId: "0xaaa" });
    const second = await createEvent(pool, { ...baseInput, polymarketMarketId: "0xbbb" });
    const seenMarketIds: Array<string | null> = [];
    const provider: EvidenceProvider = {
      name: "marketBoundProvider",
      async collect(input) {
        seenMarketIds.push(input.event.polymarketMarketId);
        return [
          {
            id: `22222222-2222-4222-8222-${String(seenMarketIds.length).padStart(12, "0")}`,
            eventId: input.event.id,
            sourceFamily: "prediction_market",
            sourceType: "polymarket_market",
            title: `Market ${input.event.polymarketMarketId}`,
            url: `https://polymarket.com/market/${input.event.polymarketMarketId}`,
            publisher: "Polymarket",
            publishedAt: "2026-10-10T09:00:00Z",
            retrievedAt: "2026-10-10T10:00:00Z",
            summary: "Market snapshot",
            rawText: null,
            entities: [],
            claims: [],
            stance: "unknown",
            qualitySignals: {},
            metadata: {},
          },
        ];
      },
    };
    const cacheStore = new InMemoryEvidenceCacheStore();

    for (const event of [first, second]) {
      await collectEvidenceForEventWithCache({
        pool,
        event,
        evaluationTime: "2026-10-11T12:15:00Z",
        mode: "live",
        providers: [provider],
        cacheStore,
      });
    }

    expect(seenMarketIds).toEqual(["0xaaa", "0xbbb"]);
  });

  it("keys cached provider output by the planned queries", async () => {
    const event = await createEvent(pool, {
      question: "Will US CPI exceed 3% in October 2026?",
      resolutionCriteria: "BLS release.",
      deadline: "2026-11-30T23:59:59Z",
      entities: ["BLS"],
      referenceClass: null,
      marketSymbols: [],
    });
    const seenQueries: Array<string[] | undefined> = [];
    const provider: EvidenceProvider = {
      name: "plannedProvider",
      async collect(input) {
        seenQueries.push(input.queries);
        return [
          {
            id: `33333333-3333-4333-8333-${String(seenQueries.length).padStart(12, "0")}`,
            eventId: input.event.id,
            sourceFamily: "web",
            sourceType: "web_article",
            title: `Planned ${seenQueries.length}`,
            url: `https://example.com/planned/${seenQueries.length}`,
            publisher: "Example",
            publishedAt: "2026-10-10T09:00:00Z",
            retrievedAt: "2026-10-10T10:00:00Z",
            summary: "Planned evidence",
            rawText: null,
            entities: [],
            claims: [],
            stance: "unknown",
            qualitySignals: {},
            metadata: {},
          },
        ];
      },
    };
    const cacheStore = new InMemoryEvidenceCacheStore();

    for (const queries of [["consensus forecast"], ["release schedule"]]) {
      await collectEvidenceForEventWithCache({
        pool,
        event,
        evaluationTime: "2026-10-11T12:15:00Z",
        mode: "live",
        providers: [provider],
        cacheStore,
        queries,
      });
    }

    expect(seenQueries).toEqual([["consensus forecast"], ["release schedule"]]);
  });

  it("bypasses cache in fixture mode even when a cache store is provided", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });

    let calls = 0;

    const provider: EvidenceProvider = {
      name: "fixtureProvider",
      async collect(input) {
        calls += 1;

        return [
          {
            id: `22222222-2222-4222-8222-${String(calls).padStart(12, "0")}`,
            eventId: input.event.id,
            sourceFamily: "web",
            sourceType: "web_article",
            title: `Fixture evidence item ${calls}`,
            url: `https://example.com/fixture-${calls}`,
            publisher: "Example News",
            publishedAt: "2026-10-10T09:00:00Z",
            retrievedAt: "2026-10-10T10:00:00Z",
            summary: "Fixture evidence summary",
            rawText: null,
            entities: ["Example Corp"],
            claims: ["Fixture claim"],
            stance: "supports",
            qualitySignals: {},
            metadata: {},
          },
        ];
      },
    };

    const cacheStore = new InMemoryEvidenceCacheStore();

    const first = await collectEvidenceForEventWithCache({
      pool,
      event,
      evaluationTime: "2026-10-11T12:15:00Z",
      mode: "fixture",
      providers: [provider],
      cacheStore,
    });

    const second = await collectEvidenceForEventWithCache({
      pool,
      event,
      evaluationTime: "2026-10-11T12:45:00Z",
      mode: "fixture",
      providers: [provider],
      cacheStore,
    });

    expect(calls).toBe(2);
    expect(first.providerRuns[0]?.cacheStatus).toBe("bypass");
    expect(second.providerRuns[0]?.cacheStatus).toBe("bypass");
  });

  it("logs provider failures as structured warnings instead of writing to console", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });

    const records: Array<Record<string, unknown>> = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        const lines = chunk.toString().split("\n").filter(Boolean);

        for (const line of lines) {
          records.push(JSON.parse(line) as Record<string, unknown>);
        }

        callback();
      },
    });
    const logger = createLogger({
      component: "test",
      destination,
      level: "warn",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(
        collectEvidenceForEventWithCache({
          pool,
          event,
          evaluationTime: "2026-10-11T12:15:00Z",
          mode: "live",
          providers: [
            {
              name: "failingProvider",
              async collect() {
                throw new Error("provider exploded");
              },
            },
          ],
          cacheStore: new InMemoryEvidenceCacheStore(),
          logger,
        }),
      ).rejects.toThrow("All 1 evidence provider(s) failed in live mode");
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnSpy).not.toHaveBeenCalled();
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: "cassandra-api",
          component: "evidence",
          event: "evidence_provider_failed",
          providerName: "failingProvider",
        }),
      ]),
    );

    const warning = records.find((record) => record.event === "evidence_provider_failed");
    expect(warning?.err).toMatchObject({
      message: "provider exploded",
      type: "Error",
    });
  });

  it("rejects live collection when every provider returns zero evidence items", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: [],
    });

    await expect(
      collectEvidenceForEventWithCache({
        pool,
        event,
        evaluationTime: "2026-10-11T12:15:00Z",
        mode: "live",
        providers: [
          {
            name: "officialSearch",
            async collect() {
              return [];
            },
          },
          {
            name: "web",
            async collect() {
              return [];
            },
          },
        ],
        cacheStore: new InMemoryEvidenceCacheStore(),
      }),
    ).rejects.toThrow("returned zero evidence items");

    const persisted = await listEvidenceForEvent(pool, event.id);
    expect(persisted).toHaveLength(0);
  });
});
