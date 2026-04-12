import { BenchmarkMarketSchema, type BenchmarkMarket } from "@cassandra/shared";
import type { Pool } from "pg";

import { assertLiveEvaluationMode } from "./liveMode.js";
import { upsertBenchmarkMarkets } from "./repository.js";

export const DEFAULT_BENCHMARK_SET_ID = "polymarket_recent_resolved";

interface PolymarketTag {
  slug?: string;
  label?: string;
}

interface PolymarketEventPayload {
  slug?: string;
  title?: string;
  description?: string;
  category?: string;
  closedTime?: string;
}

interface PolymarketMarketPayload {
  id: string;
  question?: string;
  title?: string;
  resolution_criteria?: string;
  description?: string;
  end_date_iso?: string;
  endDateIso?: string;
  endDate?: string;
  resolved_at?: string;
  closedTime?: string;
  closed?: boolean;
  archived?: boolean;
  market_slug?: string;
  slug?: string;
  volume_num?: number;
  volumeNum?: number;
  volume?: number | string;
  liquidity_num?: number;
  liquidityNum?: number;
  liquidity?: number | string;
  category?: string;
  outcomes?: string[] | string;
  outcome_prices?: number[] | string;
  outcomePrices?: number[] | string;
  tags?: PolymarketTag[];
  events?: PolymarketEventPayload[];
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

  const yesPrice = prices[yesIndex];
  const noPrice = prices[noIndex];

  if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice) || yesPrice === noPrice) {
    return null;
  }

  if (yesPrice > noPrice) {
    return true;
  }

  if (noPrice > yesPrice) {
    return false;
  }

  return null;
}

function parseStringArray(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: number[] | string | undefined): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item));
  }

  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => Number(item)) : [];
  } catch {
    return [];
  }
}

function coerceNumber(value: number | string | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    return Number(value);
  }

  return 0;
}

function normalizeTheme(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export function normalizePolymarketBenchmarkMarkets(
  markets: PolymarketMarketPayload[],
  benchmarkSetId = DEFAULT_BENCHMARK_SET_ID,
): BenchmarkMarket[] {
  return markets.flatMap((market) => {
    const primaryEvent = market.events?.[0];
    const title = market.question ?? market.title ?? primaryEvent?.title;
    const resolutionCriteria =
      market.resolution_criteria ?? market.description ?? primaryEvent?.description;
    const outcomes = parseStringArray(market.outcomes);
    const outcomePrices = parseNumberArray(market.outcome_prices ?? market.outcomePrices);
    const resolvedValue = normalizeResolvedValue(outcomes, outcomePrices);

    const resolvedAt =
      market.resolved_at ??
      market.closedTime ??
      primaryEvent?.closedTime ??
      market.end_date_iso ??
      market.endDateIso ??
      market.endDate;

    if (
      !market.closed ||
      market.archived ||
      !title ||
      !resolutionCriteria ||
      !resolvedAt ||
      resolvedValue === null
    ) {
      return [];
    }

    const theme = normalizeTheme(
      market.tags?.[0]?.slug ??
        market.tags?.[0]?.label ??
        market.category ??
        primaryEvent?.category ??
        "general",
    );
    const marketSlug = market.market_slug ?? market.slug ?? primaryEvent?.slug;
    const marketUrl = marketSlug
      ? `https://polymarket.com/event/${marketSlug}`
      : `https://polymarket.com/event/${market.id}`;

    return [
      BenchmarkMarketSchema.parse({
        id: market.id,
        benchmarkSetId,
        title,
        resolutionCriteria,
        theme,
        volume: coerceNumber(market.volume_num ?? market.volumeNum ?? market.volume),
        liquidity: coerceNumber(market.liquidity_num ?? market.liquidityNum ?? market.liquidity),
        resolvedAt: normalizeTimestamp(resolvedAt),
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
  assertLiveEvaluationMode({
    CASSANDRA_ADAPTER_MODE: args.mode ?? "live",
  });

  const fetchImpl = args.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${args.baseUrl}/markets?closed=true&uma_resolution_status=resolved`,
  );

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
