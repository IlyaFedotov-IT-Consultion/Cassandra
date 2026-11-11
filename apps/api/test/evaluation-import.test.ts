import { describe, expect, it } from "vitest";

import {
  importAndStoreResolvedPolymarketBenchmarks,
  importResolvedPolymarketBenchmarks,
  normalizePolymarketBenchmarkMarkets,
  RECENT_BENCHMARK_THEME_LIMIT,
} from "../src/modules/evaluation/polymarketImport.js";
import { buildReplayCutoffs } from "../src/modules/evaluation/replay.js";

function buildResolvedMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: "market-1",
    question: "Will Example Corp launch Product X by 2026-12-31?",
    resolution_criteria: "Official launch announcement by deadline.",
    end_date_iso: "2026-12-31T23:59:59Z",
    closedTime: "2026-12-31T23:59:59Z",
    startDate: "2026-11-01T00:00:00Z",
    closed: true,
    archived: false,
    market_slug: "example-product-x",
    volume_num: 100000,
    liquidity_num: 25000,
    outcomes: ["Yes", "No"],
    outcome_prices: [1, 0],
    ...overrides,
  };
}

describe("evaluation import", () => {
  it("excludes canceled or structurally ambiguous markets during normalization", () => {
    const markets = normalizePolymarketBenchmarkMarkets([
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
      {
        id: "market-2",
        question: "Canceled market",
        resolution_criteria: "Canceled",
        end_date_iso: "2026-12-31T23:59:59Z",
        closed: true,
        archived: true,
        market_slug: "canceled",
        volume_num: 0,
        liquidity_num: 0,
        outcomes: ["Yes", "No"],
        outcome_prices: [0, 0],
        tags: [{ slug: "other" }],
      },
      {
        id: "market-3",
        question: "Ambiguous market",
        resolution_criteria: "Too many outcomes",
        end_date_iso: "2026-12-31T23:59:59Z",
        closed: true,
        archived: false,
        market_slug: "ambiguous",
        volume_num: 1000,
        liquidity_num: 1000,
        outcomes: ["Yes", "No", "Maybe"],
        outcome_prices: [0.4, 0.3, 0.3],
        tags: [{ slug: "other" }],
      },
    ]);

    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({
      id: "market-1",
      benchmarkSetId: "polymarket_recent_resolved",
      theme: "companies_products",
      resolvedValue: true,
    });
  });

  it("imports recently resolved markets through fetch injection", async () => {
    let requestedUrl: string | undefined;
    const markets = await importResolvedPolymarketBenchmarks({
      baseUrl: "https://gamma-api.polymarket.com",
      now: new Date("2027-01-15T00:00:00Z"),
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(
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
        );
      },
    });

    expect(markets).toEqual([
      expect.objectContaining({
        benchmarkSetId: "polymarket_recent_resolved",
        id: "market-1",
        title: "Will Example Corp launch Product X by 2026-12-31?",
        theme: "companies_products",
      }),
    ]);
    expect(requestedUrl).toContain("closed=true");
    expect(requestedUrl).toContain("uma_resolution_status=resolved");
    expect(requestedUrl).toContain("order=closedTime");
    expect(requestedUrl).toContain("ascending=false");
  });

  it("honors an explicit benchmark set override during import", async () => {
    const markets = await importResolvedPolymarketBenchmarks({
      baseUrl: "https://gamma-api.polymarket.com",
      benchmarkSetId: "custom-benchmark-set",
      now: new Date("2027-01-15T00:00:00Z"),
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

    expect(markets).toEqual([
      expect.objectContaining({
        benchmarkSetId: "custom-benchmark-set",
        id: "market-1",
      }),
    ]);
  });

  it("filters out stale resolved markets outside the recent benchmark window", async () => {
    const markets = await importResolvedPolymarketBenchmarks({
      baseUrl: "https://gamma-api.polymarket.com",
      now: new Date("2026-04-12T00:00:00Z"),
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              id: "market-recent",
              question: "Will Example Corp launch Product X by 2026-04-15?",
              resolution_criteria: "Official launch announcement by deadline.",
              closedTime: "2026-04-10T23:59:59Z",
              closed: true,
              archived: false,
              market_slug: "example-product-x",
              volume_num: 100000,
              liquidity_num: 25000,
              outcomes: ["Yes", "No"],
              outcome_prices: [1, 0],
              tags: [{ slug: "technology" }],
            },
            {
              id: "market-stale",
              question: "Did something happen months ago?",
              resolution_criteria: "Official confirmation.",
              closedTime: "2025-12-31T23:59:59Z",
              closed: true,
              archived: false,
              market_slug: "stale-market",
              volume_num: 1000,
              liquidity_num: 100,
              outcomes: ["Yes", "No"],
              outcome_prices: [1, 0],
              tags: [{ slug: "general" }],
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

    expect(markets.map((market) => market.id)).toEqual(["market-recent"]);
  });

  it("normalizes the current Polymarket Gamma payload shape", () => {
    const markets = normalizePolymarketBenchmarkMarkets([
      {
        id: "12",
        question: "Will Joe Biden get Coronavirus before the election?",
        description: "Resolves yes if Joe Biden publicly confirms a positive COVID-19 test before November 3, 2020.",
        slug: "will-joe-biden-get-coronavirus-before-the-election",
        endDate: "2020-11-04T00:00:00Z",
        closedTime: "2020-11-02 16:31:01+00",
        category: "US-current-affairs",
        volumeNum: 32257.45,
        liquidityNum: 0,
        closed: true,
        archived: false,
        outcomes: "[\"Yes\", \"No\"]",
        outcomePrices: "[\"0.000000695371682462938946447150318990679\", \"0.999999304628317537061053552849681\"]",
      } as never,
    ]);

    expect(markets).toEqual([
      expect.objectContaining({
        id: "12",
        title: "Will Joe Biden get Coronavirus before the election?",
        resolutionCriteria: "Resolves yes if Joe Biden publicly confirms a positive COVID-19 test before November 3, 2020.",
        theme: "politics_elections",
        volume: 32257.45,
        liquidity: 0,
        resolvedAt: "2020-11-02T16:31:01.000Z",
        resolvedValue: false,
        marketUrl:
          "https://polymarket.com/event/will-joe-biden-get-coronavirus-before-the-election",
      }),
    ]);
  });

  it("filters structurally incompatible markets and infers canonical benchmark themes", () => {
    const markets = normalizePolymarketBenchmarkMarkets([
      buildResolvedMarket({
        id: "company-market",
        question: "Will Example Corp launch Product X by 2026-12-31?",
      }),
      buildResolvedMarket({
        id: "geopolitics-market",
        question: "Will JD Vance talk to Iranian negotiators by April 30?",
        market_slug: "jd-vance-iran-negotiators",
        closedTime: "2026-04-12T12:00:00Z",
        end_date_iso: "2026-04-12T12:00:00Z",
        startDate: "2026-03-24T12:00:00Z",
      }),
      buildResolvedMarket({
        id: "sports-prop",
        question: "Jane Doe: Anytime Goalscorer",
        market_slug: "jane-doe-anytime-goalscorer",
        closedTime: "2026-04-12T12:00:00Z",
        end_date_iso: "2026-04-12T12:00:00Z",
        startDate: "2026-04-11T12:00:00Z",
        events: [{ title: "Springfield FC vs. Shelbyville FC" }],
      }),
      buildResolvedMarket({
        id: "weather-market",
        question: "Will the highest temperature in Taipei be 31°C on April 12?",
        market_slug: "taipei-temperature-april-12",
        closedTime: "2026-04-12T12:00:00Z",
        end_date_iso: "2026-04-12T12:00:00Z",
        startDate: "2026-04-11T12:00:00Z",
      }),
    ]);

    expect(markets).toEqual([
      expect.objectContaining({
        id: "company-market",
        theme: "companies_products",
      }),
      expect.objectContaining({
        id: "geopolitics-market",
        theme: "geopolitics_policy",
      }),
    ]);
  });

  it("keeps fetching later benchmark pages when the first page is dominated by junk markets", async () => {
    const requestedUrls: string[] = [];

    const markets = await importResolvedPolymarketBenchmarks({
      baseUrl: "https://gamma-api.polymarket.com",
      now: new Date("2026-04-12T00:00:00Z"),
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        requestedUrls.push(url.toString());
        const offset = url.searchParams.get("offset");

        if (offset === null) {
          return new Response(
            JSON.stringify([
              buildResolvedMarket({
                id: "sports-prop-1",
                question: "Jane Doe: Anytime Goalscorer",
                closedTime: "2026-04-10T12:00:00Z",
                end_date_iso: "2026-04-10T12:00:00Z",
                startDate: "2026-04-09T12:00:00Z",
                events: [{ title: "Springfield FC vs. Shelbyville FC" }],
              }),
              buildResolvedMarket({
                id: "sports-prop-2",
                question: "Exact Score: Springfield FC vs. Shelbyville FC",
                closedTime: "2026-04-10T13:00:00Z",
                end_date_iso: "2026-04-10T13:00:00Z",
                startDate: "2026-04-09T13:00:00Z",
                events: [{ title: "Springfield FC vs. Shelbyville FC" }],
              }),
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        if (offset === "200") {
          return new Response(
            JSON.stringify([
              buildResolvedMarket({
                id: "policy-market",
                question: "Will JD Vance talk to Iranian negotiators by April 30?",
                market_slug: "jd-vance-iran-negotiators",
                closedTime: "2026-04-12T12:00:00Z",
                end_date_iso: "2026-04-12T12:00:00Z",
                startDate: "2026-03-24T12:00:00Z",
              }),
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    expect(markets).toEqual([
      expect.objectContaining({
        id: "policy-market",
        theme: "geopolitics_policy",
      }),
    ]);
    expect(requestedUrls.some((url) => url.includes("offset=200"))).toBe(true);
  });

  it("caps benchmark imports from a single theme so one cycle cannot dominate the set", async () => {
    const politicsMarkets = Array.from({ length: RECENT_BENCHMARK_THEME_LIMIT + 3 }, (_, index) =>
      buildResolvedMarket({
        id: `politics-${index}`,
        question: `Will Candidate ${index} win the 2026 mayoral election?`,
        market_slug: `candidate-${index}-mayor-election`,
        closedTime: "2026-04-12T12:00:00Z",
        end_date_iso: "2026-04-12T12:00:00Z",
        startDate: "2026-03-01T12:00:00Z",
      }),
    );
    const cryptoMarkets = [
      buildResolvedMarket({
        id: "crypto-1",
        question: "Will Bitcoin close above $100k by April 30?",
        market_slug: "bitcoin-100k-april-30",
        closedTime: "2026-04-12T12:00:00Z",
        end_date_iso: "2026-04-12T12:00:00Z",
        startDate: "2026-03-01T12:00:00Z",
      }),
      buildResolvedMarket({
        id: "crypto-2",
        question: "Will Ethereum close above $3,000 by April 30?",
        market_slug: "ethereum-3000-april-30",
        closedTime: "2026-04-12T12:00:00Z",
        end_date_iso: "2026-04-12T12:00:00Z",
        startDate: "2026-03-01T12:00:00Z",
      }),
    ];

    const markets = await importResolvedPolymarketBenchmarks({
      baseUrl: "https://gamma-api.polymarket.com",
      now: new Date("2026-04-12T00:00:00Z"),
      fetchImpl: async () =>
        new Response(JSON.stringify([...politicsMarkets, ...cryptoMarkets]), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
    });

    expect(markets.filter((market) => market.theme === "politics_elections")).toHaveLength(
      RECENT_BENCHMARK_THEME_LIMIT,
    );
    expect(markets.filter((market) => market.theme === "crypto_regulation")).toHaveLength(2);
  });

  it("rejects fixture-mode benchmark imports", async () => {
    await expect(
      importResolvedPolymarketBenchmarks({
        baseUrl: "https://gamma-api.polymarket.com",
        mode: "fixture",
      }),
    ).rejects.toThrow("Real evaluations require CASSANDRA_ADAPTER_MODE=live");
  });

  it("imports and persists resolved markets through the evaluation repository", async () => {
    const captured: unknown[][] = [];
    const resolvedAt = "2026-12-31T23:59:59Z";
    const replayCutoffs = buildReplayCutoffs(resolvedAt);
    const pool = {
      async query(text: string, params?: unknown[]) {
        captured.push(params ?? []);

        if (text.includes("UPDATE benchmark_markets")) {
          return {
            rows: [],
            rowCount: 0,
          };
        }

        if (text.includes("INSERT INTO benchmark_price_snapshots")) {
          return {
            rows: [
              {
                id: `snapshot-${captured.length}`,
                benchmark_market_id: params?.[0],
                cutoff_at: new Date(String(params?.[1])),
                probability: params?.[2],
                volume: params?.[3],
                liquidity: params?.[4],
                source: params?.[5],
                created_at: new Date("2026-12-31T00:00:00Z"),
              },
            ],
          };
        }

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
              resolved_at: new Date(resolvedAt),
              resolved_value: true,
              market_url: "https://polymarket.com/event/example-product-x",
            },
          ],
        };
      },
    } as never;

    const markets = await importAndStoreResolvedPolymarketBenchmarks({
      pool,
      baseUrl: "https://gamma-api.polymarket.com",
      clobBaseUrl: "https://clob.polymarket.com",
      now: new Date("2027-01-15T00:00:00Z"),
      fetchImpl: async (input) => {
        const url = new URL(String(input));

        if (url.origin === "https://gamma-api.polymarket.com") {
          return new Response(
            JSON.stringify([
              {
                id: "market-1",
                question: "Will Example Corp launch Product X by 2026-12-31?",
                resolution_criteria: "Official launch announcement by deadline.",
                end_date_iso: resolvedAt,
                closedTime: resolvedAt,
                startDate: "2026-11-01T00:00:00Z",
                closed: true,
                archived: false,
                market_slug: "example-product-x",
                volume_num: 100000,
                liquidity_num: 25000,
                outcomes: ["Yes", "No"],
                outcome_prices: [1, 0],
                clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
                tags: [{ slug: "technology" }],
              },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        const endTs = Number(url.searchParams.get("endTs"));
        return new Response(
          JSON.stringify({
            history: [
              {
                t: endTs - 60,
                p: 0.61,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    expect(markets).toEqual([
      expect.objectContaining({
        benchmarkSetId: "polymarket_recent_resolved",
        id: "market-1",
        theme: "technology",
      }),
    ]);
    expect(captured).toHaveLength(2 + replayCutoffs.length);
    expect(captured[0]).toContain("polymarket_recent_resolved");
    expect(captured[1]).toEqual([
      "polymarket_recent_resolved",
      ["market-1"],
    ]);
    expect(captured.slice(1)).toEqual(
      [
        ["polymarket_recent_resolved", ["market-1"]],
        ...replayCutoffs.map((cutoff) =>
          expect.arrayContaining([
            "market-1",
            cutoff.cutoffAt,
            0.61,
            100000,
            25000,
            "polymarket",
          ]),
        ),
      ],
    );
  });

  it("reconciles a benchmark set by retiring stale rows during import", async () => {
    const deleted: unknown[][] = [];
    const pool = {
      async query(text: string, params?: unknown[]) {
        if (text.includes("UPDATE benchmark_markets")) {
          deleted.push(params ?? []);
          return {
            rows: [{ id: "market-stale" }],
            rowCount: 1,
          };
        }

        if (text.includes("INSERT INTO benchmark_price_snapshots")) {
          return {
            rows: [
              {
                id: "snapshot-1",
                benchmark_market_id: params?.[0],
                cutoff_at: new Date(String(params?.[1])),
                probability: params?.[2],
                volume: params?.[3],
                liquidity: params?.[4],
                source: params?.[5],
                created_at: new Date("2026-12-31T00:00:00Z"),
              },
            ],
          };
        }

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

    await importAndStoreResolvedPolymarketBenchmarks({
      pool,
      baseUrl: "https://gamma-api.polymarket.com",
      clobBaseUrl: "https://clob.polymarket.com",
      now: new Date("2027-01-15T00:00:00Z"),
      fetchImpl: async (input) => {
        const url = new URL(String(input));

        if (url.origin === "https://gamma-api.polymarket.com") {
          return new Response(
            JSON.stringify([
              {
                id: "market-1",
                question: "Will Example Corp launch Product X by 2026-12-31?",
                resolution_criteria: "Official launch announcement by deadline.",
                end_date_iso: "2026-12-31T23:59:59Z",
                closedTime: "2026-12-31T23:59:59Z",
                startDate: "2026-11-01T00:00:00Z",
                closed: true,
                archived: false,
                market_slug: "example-product-x",
                volume_num: 100000,
                liquidity_num: 25000,
                outcomes: ["Yes", "No"],
                outcome_prices: [1, 0],
                clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
                tags: [{ slug: "technology" }],
              },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        const endTs = Number(url.searchParams.get("endTs"));
        return new Response(
          JSON.stringify({
            history: [{ t: endTs - 60, p: 0.61 }],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    expect(deleted).toEqual([[ "polymarket_recent_resolved", ["market-1"] ]]);
  });

  it("skips snapshot cutoffs that predate the market start time", async () => {
    const snapshotWrites: unknown[][] = [];
    const pool = {
      async query(text: string, params?: unknown[]) {
        if (text.includes("UPDATE benchmark_markets")) {
          return {
            rows: [],
            rowCount: 0,
          };
        }

        if (text.includes("INSERT INTO benchmark_price_snapshots")) {
          snapshotWrites.push(params ?? []);
          return {
            rows: [
              {
                id: "snapshot-1",
                benchmark_market_id: params?.[0],
                cutoff_at: new Date(String(params?.[1])),
                probability: params?.[2],
                volume: params?.[3],
                liquidity: params?.[4],
                source: params?.[5],
                created_at: new Date("2026-12-31T00:00:00Z"),
              },
            ],
          };
        }

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

    await importAndStoreResolvedPolymarketBenchmarks({
      pool,
      baseUrl: "https://gamma-api.polymarket.com",
      clobBaseUrl: "https://clob.polymarket.com",
      now: new Date("2027-01-15T00:00:00Z"),
      fetchImpl: async (input) => {
        const url = new URL(String(input));

        if (url.origin === "https://gamma-api.polymarket.com") {
          return new Response(
            JSON.stringify([
              {
                id: "market-1",
                question: "Will Example Corp launch Product X by 2026-12-31?",
                resolution_criteria: "Official launch announcement by deadline.",
                end_date_iso: "2026-12-31T23:59:59Z",
                closedTime: "2026-12-31T23:59:59Z",
                startDate: "2026-12-25T00:00:00Z",
                closed: true,
                archived: false,
                market_slug: "example-product-x",
                volume_num: 100000,
                liquidity_num: 25000,
                outcomes: ["Yes", "No"],
                outcome_prices: [1, 0],
                clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
                tags: [{ slug: "technology" }],
              },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          );
        }

        const endTs = Number(url.searchParams.get("endTs"));
        return new Response(
          JSON.stringify({
            history: [{ t: endTs - 60, p: 0.61 }],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    expect(snapshotWrites).toHaveLength(2);
    expect(snapshotWrites.every((params) => String(params[1]).startsWith("2026-12-"))).toBe(true);
  });
});

describe("benchmark import metadata", () => {
  it("keeps the market's scheduled end date separately from its close time", () => {
    const [market] = normalizePolymarketBenchmarkMarkets([
      {
        id: "market-early",
        question: "Will Example Corp launch Product X by 2026-12-31?",
        description: "Official launch announcement by deadline.",
        closedTime: "2026-10-15T09:00:00Z",
        endDate: "2026-12-31T23:59:59Z",
        closed: true,
        archived: false,
        slug: "example-product-x",
        volumeNum: 100000,
        liquidityNum: 25000,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["1", "0"]',
      },
    ]);

    expect(market).toMatchObject({
      resolvedAt: "2026-10-15T09:00:00.000Z",
      endDate: "2026-12-31T23:59:59.000Z",
    });
  });

  it("does not classify generic 'Who will' questions as science and health", () => {
    const [market] = normalizePolymarketBenchmarkMarkets([
      {
        id: "market-who",
        question: "Who will be the next chair of the city planning board?",
        description: "Resolves to the appointed chair.",
        closedTime: "2026-10-15T09:00:00Z",
        closed: true,
        archived: false,
        slug: "next-chair",
        volumeNum: 1000,
        liquidityNum: 1000,
        outcomes: '["Yes", "No"]',
        outcomePrices: '["1", "0"]',
      },
    ]);

    expect(market?.theme).not.toBe("science_health");
  });

  it("requests every page of recently resolved markets without skipping an offset", async () => {
    const offsets: Array<string | null> = [];
    await importResolvedPolymarketBenchmarks({
      baseUrl: "https://gamma-api.polymarket.com",
      now: new Date("2027-01-15T00:00:00Z"),
      fetchImpl: async (input) => {
        offsets.push(new URL(String(input)).searchParams.get("offset"));
        return new Response("[]", { status: 200 });
      },
    });

    expect(offsets.slice(0, 3)).toEqual([null, "100", "200"]);
  });

  describe("a larger benchmark set, to give calibration more to learn from", () => {
    const politics = (count: number, closedTime: string) =>
      Array.from({ length: count }, (_, index) =>
        buildResolvedMarket({
          id: `politics-${closedTime}-${index}`,
          question: `Will Candidate ${index} win the 2026 mayoral election (${closedTime})?`,
          market_slug: `candidate-${index}-${closedTime}`,
          closedTime,
          end_date_iso: closedTime,
          startDate: "2025-10-01T12:00:00Z",
        }),
      );
    const importWith = (markets: unknown[], selection: Record<string, number>) =>
      importResolvedPolymarketBenchmarks({
        baseUrl: "https://gamma-api.polymarket.com",
        now: new Date("2026-04-12T00:00:00Z"),
        selection,
        fetchImpl: async () => new Response(JSON.stringify(markets), { status: 200 }),
      });

    it("keeps as many markets, and as many per theme, as asked", async () => {
      const markets = politics(30, "2026-04-10T12:00:00Z");

      expect(await importWith(markets, {})).toHaveLength(RECENT_BENCHMARK_THEME_LIMIT);
      expect(await importWith(markets, { themeLimit: 25 })).toHaveLength(25);
      expect(await importWith(markets, { themeLimit: 25, limit: 7 })).toHaveLength(7);
    });

    it("reaches further back when given a longer window", async () => {
      const markets = [...politics(2, "2026-04-10T12:00:00Z"), ...politics(2, "2025-12-01T12:00:00Z")];

      expect(await importWith(markets, {})).toHaveLength(2);
      expect(await importWith(markets, { windowDays: 200 })).toHaveLength(4);
    });

    it("scans as many pages of closed markets as asked", async () => {
      const offsets: Array<string | null> = [];
      await importResolvedPolymarketBenchmarks({
        baseUrl: "https://gamma-api.polymarket.com",
        now: new Date("2027-01-15T00:00:00Z"),
        selection: { pages: 3 },
        fetchImpl: async (input) => {
          offsets.push(new URL(String(input)).searchParams.get("offset"));
          return new Response("[]", { status: 200 });
        },
      });

      expect(offsets).toEqual([null, "100", "200"]);
    });
  });
});
