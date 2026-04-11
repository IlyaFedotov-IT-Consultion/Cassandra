import { BenchmarkMarketSchema, type BenchmarkMarket } from "@cassandra/shared";
import type { Pool } from "pg";

import { upsertBenchmarkMarkets } from "./repository.js";

export const DEFAULT_BENCHMARK_SET_ID = "polymarket_recent_resolved";

const fixtureResolvedPolymarketMarkets: PolymarketMarketPayload[] = [
  {
    id: "fixture-market-fed-hold",
    question: "Will the Fed hold rates steady at the next FOMC meeting?",
    resolution_criteria: "Resolves Yes if the target range is unchanged at the next scheduled FOMC decision.",
    end_date_iso: "2026-06-17T18:00:00Z",
    resolved_at: "2026-06-17T18:00:00Z",
    closed: true,
    archived: false,
    market_slug: "fed-hold-next-fomc",
    volume_num: 245000,
    liquidity_num: 68000,
    outcomes: ["Yes", "No"],
    outcome_prices: [1, 0],
    tags: [{ slug: "macro" }],
  },
  {
    id: "fixture-market-eu-fine",
    question: "Will the EU fine Example Tech over antitrust conduct before July 2026?",
    resolution_criteria: "Resolves Yes if the European Commission announces a formal monetary penalty before July 1, 2026.",
    end_date_iso: "2026-07-01T00:00:00Z",
    resolved_at: "2026-06-21T09:00:00Z",
    closed: true,
    archived: false,
    market_slug: "eu-antitrust-fine-example-tech",
    volume_num: 118000,
    liquidity_num: 41000,
    outcomes: ["Yes", "No"],
    outcome_prices: [0, 1],
    tags: [{ slug: "policy" }],
  },
  {
    id: "fixture-market-launch-delay",
    question: "Will Example Motors ship its new EV before September 2026?",
    resolution_criteria: "Resolves Yes if customer deliveries of the announced EV begin before September 1, 2026.",
    end_date_iso: "2026-09-01T00:00:00Z",
    resolved_at: "2026-08-28T16:00:00Z",
    closed: true,
    archived: false,
    market_slug: "example-motors-ev-shipments",
    volume_num: 196000,
    liquidity_num: 53000,
    outcomes: ["Yes", "No"],
    outcome_prices: [1, 0],
    tags: [{ slug: "technology" }],
  },
];

interface PolymarketTag {
  slug?: string;
  label?: string;
}

interface PolymarketMarketPayload {
  id: string;
  question?: string;
  title?: string;
  resolution_criteria?: string;
  description?: string;
  end_date_iso?: string;
  resolved_at?: string;
  closed?: boolean;
  archived?: boolean;
  market_slug?: string;
  volume_num?: number;
  liquidity_num?: number;
  outcomes?: string[];
  outcome_prices?: number[];
  tags?: PolymarketTag[];
}

function normalizeResolvedValue(outcomes: string[], prices: number[]): boolean | null {
  if (outcomes.length !== 2 || prices.length !== 2) {
    return null;
  }

  const normalizedOutcomes = outcomes.map((outcome) => outcome.trim().toLowerCase());
  const yesIndex = normalizedOutcomes.indexOf("yes");
  const noIndex = normalizedOutcomes.indexOf("no");

  if (yesIndex === -1 || noIndex === -1) {
    return null;
  }

  if (prices[yesIndex] === 1 && prices[noIndex] === 0) {
    return true;
  }

  if (prices[yesIndex] === 0 && prices[noIndex] === 1) {
    return false;
  }

  return null;
}

export function normalizePolymarketBenchmarkMarkets(
  markets: PolymarketMarketPayload[],
  benchmarkSetId = DEFAULT_BENCHMARK_SET_ID,
): BenchmarkMarket[] {
  return markets.flatMap((market) => {
    const title = market.question ?? market.title;
    const resolutionCriteria = market.resolution_criteria ?? market.description;
    const outcomes = market.outcomes ?? [];
    const outcomePrices = market.outcome_prices ?? [];
    const resolvedValue = normalizeResolvedValue(outcomes, outcomePrices);

    if (!market.closed || market.archived || !title || !resolutionCriteria || resolvedValue === null) {
      return [];
    }

    const theme = market.tags?.[0]?.slug ?? market.tags?.[0]?.label ?? "general";
    const resolvedAt = market.resolved_at ?? market.end_date_iso;
    const marketUrl = market.market_slug
      ? `https://polymarket.com/event/${market.market_slug}`
      : `https://polymarket.com/event/${market.id}`;

    return [
      BenchmarkMarketSchema.parse({
        id: market.id,
        benchmarkSetId,
        title,
        resolutionCriteria,
        theme,
        volume: market.volume_num ?? 0,
        liquidity: market.liquidity_num ?? 0,
        resolvedAt,
        resolvedValue,
        marketUrl,
      }),
    ];
  });
}

export async function importResolvedPolymarketBenchmarks(args: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  benchmarkSetId?: string;
  mode?: "fixture" | "live";
}): Promise<BenchmarkMarket[]> {
  if (args.mode === "fixture") {
    return normalizePolymarketBenchmarkMarkets(
      fixtureResolvedPolymarketMarkets,
      args.benchmarkSetId,
    );
  }

  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(`${args.baseUrl}/markets?closed=true`);

  if (!response.ok) {
    throw new Error(`Polymarket import failed with ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as PolymarketMarketPayload[];
  return normalizePolymarketBenchmarkMarkets(payload, args.benchmarkSetId);
}

export async function importAndStoreResolvedPolymarketBenchmarks(args: {
  pool: Pool;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  benchmarkSetId?: string;
  mode?: "fixture" | "live";
}): Promise<BenchmarkMarket[]> {
  const markets = await importResolvedPolymarketBenchmarks({
    baseUrl: args.baseUrl,
    fetchImpl: args.fetchImpl,
    benchmarkSetId: args.benchmarkSetId,
    mode: args.mode,
  });

  return upsertBenchmarkMarkets(args.pool, markets);
}
