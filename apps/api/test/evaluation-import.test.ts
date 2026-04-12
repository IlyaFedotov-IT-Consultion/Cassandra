import { describe, expect, it } from "vitest";

import {
  importAndStoreResolvedPolymarketBenchmarks,
  importResolvedPolymarketBenchmarks,
  normalizePolymarketBenchmarkMarkets,
} from "../src/modules/evaluation/polymarketImport.js";

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
      theme: "technology",
      resolvedValue: true,
    });
  });

  it("imports recently resolved markets through fetch injection", async () => {
    let requestedUrl: string | undefined;
    const markets = await importResolvedPolymarketBenchmarks({
      baseUrl: "https://gamma-api.polymarket.com",
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
        theme: "technology",
      }),
    ]);
    expect(requestedUrl).toContain("closed=true");
    expect(requestedUrl).toContain("uma_resolution_status=resolved");
  });

  it("honors an explicit benchmark set override during import", async () => {
    const markets = await importResolvedPolymarketBenchmarks({
      baseUrl: "https://gamma-api.polymarket.com",
      benchmarkSetId: "custom-benchmark-set",
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
        theme: "us-current-affairs",
        volume: 32257.45,
        liquidity: 0,
        resolvedAt: "2020-11-02T16:31:01.000Z",
        resolvedValue: false,
        marketUrl:
          "https://polymarket.com/event/will-joe-biden-get-coronavirus-before-the-election",
      }),
    ]);
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
    const pool = {
      async query(_text: string, params?: unknown[]) {
        captured.push(params ?? []);

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

    const markets = await importAndStoreResolvedPolymarketBenchmarks({
      pool,
      baseUrl: "https://gamma-api.polymarket.com",
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
        benchmarkSetId: "polymarket_recent_resolved",
        id: "market-1",
        theme: "technology",
      }),
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("polymarket_recent_resolved");
  });
});
