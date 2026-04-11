import { BenchmarkMarketSchema, type BenchmarkMarket } from "@cassandra/shared";
import type { Pool } from "pg";

import { upsertBenchmarkMarkets } from "./repository.js";

export const DEFAULT_BENCHMARK_SET_ID = "polymarket_recent_resolved";

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
}): Promise<BenchmarkMarket[]> {
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
}): Promise<BenchmarkMarket[]> {
  const markets = await importResolvedPolymarketBenchmarks({
    baseUrl: args.baseUrl,
    fetchImpl: args.fetchImpl,
    benchmarkSetId: args.benchmarkSetId,
  });

  return upsertBenchmarkMarkets(args.pool, markets);
}
