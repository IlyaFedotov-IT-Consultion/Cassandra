import { BenchmarkMarketSchema, type BenchmarkMarket } from "@cassandra/shared";
import type { Pool } from "pg";

import { assertLiveEvaluationMode } from "./liveMode.js";
import { buildReplayCutoffs } from "./replay.js";
import {
  syncBenchmarkMarkets,
  upsertBenchmarkMarkets,
  upsertBenchmarkPriceSnapshots,
  type BenchmarkPriceSnapshotInput,
} from "./repository.js";

export const DEFAULT_BENCHMARK_SET_ID = "polymarket_recent_resolved";
const RECENT_BENCHMARK_WINDOW_DAYS = 56;
const RECENT_BENCHMARK_IMPORT_LIMIT = 50;
export const RECENT_BENCHMARK_THEME_LIMIT = 12;
const RECENT_BENCHMARK_MIN_OPEN_HOURS = 24;
const HISTORY_LOOKBACK_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const HISTORY_FIDELITY_MINUTES = 60;
const RECENT_BENCHMARK_PAGE_REQUESTS: ReadonlyArray<{ limit: number; offset?: number }> = [
  { limit: 100 },
  { limit: 100, offset: 100 },
  { limit: 100, offset: 200 },
  { limit: 100, offset: 300 },
  { limit: 100, offset: 400 },
  { limit: 100, offset: 500 },
  { limit: 100, offset: 600 },
  { limit: 100, offset: 700 },
  { limit: 100, offset: 800 },
] as const;
const THEME_PRIORITY = [
  "politics_elections",
  "macro_economics",
  "companies_products",
  "crypto_regulation",
  "geopolitics_policy",
  "science_health",
] as const;
const STRUCTURALLY_INCOMPATIBLE_PATTERNS = [
  /\banytime goalscorer\b/i,
  /\bexact score\b/i,
  /\bo\/u\b/i,
  /\bover\/under\b/i,
  /\bup or down\b/i,
  /\bset \d+\b/i,
  /\bgame \d+\b/i,
  /\bmap \d+\b/i,
  /\bperiod \d+\b/i,
  /\binnings?\b/i,
  /\bodd\/even\b/i,
  /\bspread:/i,
  /\bmoneyline\b/i,
  /\bcorrect score\b/i,
  /\bto score\b/i,
  /\bultra kill\b/i,
  /\bbeat roshan\b/i,
  /\bends in daytime\b/i,
  /\bmatch winner\b/i,
  /\bhighest temperature\b/i,
  /\bplace \d+(st|nd|rd|th)\b/i,
  /\brelegation\b/i,
];

interface PolymarketTag {
  slug?: string;
  label?: string;
}

interface PolymarketSeriesPayload {
  slug?: string;
  title?: string;
}

interface PolymarketEventPayload {
  slug?: string;
  title?: string;
  description?: string;
  category?: string;
  closedTime?: string;
  startDate?: string;
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
  createdAt?: string;
  startDate?: string;
  startDateIso?: string;
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
  groupItemTitle?: string;
  outcomes?: string[] | string;
  outcome_prices?: number[] | string;
  outcomePrices?: number[] | string;
  clobTokenIds?: string[] | string;
  tags?: PolymarketTag[];
  events?: PolymarketEventPayload[];
  series?: PolymarketSeriesPayload | null;
}

interface NormalizedPolymarketBenchmarkEntry {
  market: BenchmarkMarket;
  yesTokenId: string | null;
  startAt: string | null;
}

interface PolymarketPriceHistoryPoint {
  t: number;
  p: number;
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

  if (
    yesPrice === undefined ||
    noPrice === undefined ||
    !Number.isFinite(yesPrice) ||
    !Number.isFinite(noPrice) ||
    yesPrice === noPrice
  ) {
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

function parseTokenIdArray(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
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

function themePriority(theme: string): number {
  const priority = THEME_PRIORITY.indexOf(theme as (typeof THEME_PRIORITY)[number]);
  return priority === -1 ? THEME_PRIORITY.length : priority;
}

function buildThemeSourceText(
  market: PolymarketMarketPayload,
  title: string,
  resolutionCriteria: string,
): string {
  const primaryEvent = market.events?.[0];
  return [
    title,
    resolutionCriteria,
    market.groupItemTitle,
    primaryEvent?.title,
    primaryEvent?.description,
    market.category,
    primaryEvent?.category,
    market.series?.title,
    market.series?.slug,
    market.tags?.map((tag) => tag.slug ?? tag.label).join(" "),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" | ");
}

function inferBenchmarkTheme(
  market: PolymarketMarketPayload,
  title: string,
  resolutionCriteria: string,
): string {
  const sourceText = buildThemeSourceText(market, title, resolutionCriteria).toLowerCase();

  if (
    /\b(nhl|nba|mlb|nfl|soccer|football|tennis|dota|valorant|counter-strike|esports|playoffs|qualifier|premier league|epl|la liga|serie a|bundesliga|mls|kbl|vtb united league)\b/.test(
      sourceText,
    ) ||
    /\b(fc|cfc|calcio)\b/.test(sourceText)
  ) {
    return "sports";
  }

  if (/\b(weather|temperature|rain|snow|°c|°f)\b/.test(sourceText)) {
    return "weather";
  }

  if (/\b(coachella|song|album|movie|box office|billboard)\b/.test(sourceText)) {
    return "entertainment";
  }

  if (
    /\b(bitcoin|ethereum|solana|dogecoin|xrp|bnb|hyperliquid|crypto|etf|stablecoin|coinbase|binance|token|blockchain)\b/.test(
      sourceText,
    )
  ) {
    return "crypto_regulation";
  }

  if (
    /\b(cpi|inflation|gdp|unemployment|jobs report|payrolls|fed|fomc|rate cut|rate hike|treasury|yield|recession|pmi|economic)\b/.test(
      sourceText,
    )
  ) {
    return "macro_economics";
  }

  if (
    /\b(tariff|sanction|ceasefire|treaty|iran|ukraine|israel|gaza|china|taiwan|nato|negotiators|public policy|public-policy)\b/.test(
      sourceText,
    )
  ) {
    return "geopolitics_policy";
  }

  if (
    /\b(election|president|prime minister|parliament|senate|governor|mayor|vote share|coalition|minister|cabinet|referendum|campaign|ballot|congress|supreme court|jd vance|trump|biden)\b/.test(
      sourceText,
    )
  ) {
    return "politics_elections";
  }

  if (
    /\b(elon musk|spacex|tesla|apple|meta|google|alphabet|amazon|microsoft|openai|anthropic|launch|earnings|product|ipo|merger|acquisition)\b/.test(
      sourceText,
    )
  ) {
    return "companies_products";
  }

  // "WHO" (the organization) is matched case-sensitively so "Who will..." questions do not qualify.
  if (
    /\b(covid|vaccine|fda|trial|disease|public health|world health organization)\b/.test(sourceText) ||
    /\bWHO\b/.test(buildThemeSourceText(market, title, resolutionCriteria))
  ) {
    return "science_health";
  }

  return normalizeTheme(
    market.tags?.[0]?.slug ??
      market.tags?.[0]?.label ??
      market.category ??
      market.events?.[0]?.category ??
      "general",
  );
}

function isStructurallyCompatibleBenchmarkMarket(args: {
  market: PolymarketMarketPayload;
  title: string;
  resolutionCriteria: string;
  resolvedAt: string;
  startAt: string | null;
  theme: string;
}): boolean {
  const sourceText = buildThemeSourceText(args.market, args.title, args.resolutionCriteria);

  if (STRUCTURALLY_INCOMPATIBLE_PATTERNS.some((pattern) => pattern.test(sourceText))) {
    return false;
  }

  if (args.theme === "sports" || args.theme === "weather" || args.theme === "entertainment") {
    return false;
  }

  if (!args.startAt) {
    return true;
  }

  const openDurationHours =
    (new Date(args.resolvedAt).getTime() - new Date(args.startAt).getTime()) / (60 * 60 * 1000);

  return openDurationHours >= RECENT_BENCHMARK_MIN_OPEN_HOURS;
}

function curateBenchmarkEntries(
  entries: NormalizedPolymarketBenchmarkEntry[],
): NormalizedPolymarketBenchmarkEntry[] {
  const groupedEntries = new Map<string, NormalizedPolymarketBenchmarkEntry[]>();

  for (const entry of entries) {
    const themeEntries = groupedEntries.get(entry.market.theme) ?? [];
    themeEntries.push(entry);
    groupedEntries.set(entry.market.theme, themeEntries);
  }

  for (const themeEntries of groupedEntries.values()) {
    themeEntries.sort((left, right) => {
      const resolvedAtDelta =
        new Date(right.market.resolvedAt).getTime() - new Date(left.market.resolvedAt).getTime();

      if (resolvedAtDelta !== 0) {
        return resolvedAtDelta;
      }

      return right.market.volume - left.market.volume;
    });
  }

  const orderedThemes = Array.from(groupedEntries.keys()).sort((left, right) => {
    const priorityDelta = themePriority(left) - themePriority(right);
    return priorityDelta !== 0 ? priorityDelta : left.localeCompare(right);
  });
  const selectedEntries: NormalizedPolymarketBenchmarkEntry[] = [];
  const selectedByTheme = new Map<string, number>();

  while (selectedEntries.length < RECENT_BENCHMARK_IMPORT_LIMIT) {
    let addedEntry = false;

    for (const theme of orderedThemes) {
      const themeEntries = groupedEntries.get(theme);

      if (!themeEntries || themeEntries.length === 0) {
        continue;
      }

      if ((selectedByTheme.get(theme) ?? 0) >= RECENT_BENCHMARK_THEME_LIMIT) {
        continue;
      }

      const nextEntry = themeEntries.shift();

      if (!nextEntry) {
        continue;
      }

      selectedEntries.push(nextEntry);
      selectedByTheme.set(theme, (selectedByTheme.get(theme) ?? 0) + 1);
      addedEntry = true;

      if (selectedEntries.length >= RECENT_BENCHMARK_IMPORT_LIMIT) {
        break;
      }
    }

    if (!addedEntry) {
      break;
    }
  }

  return selectedEntries;
}

function normalizePolymarketBenchmarkEntries(
  markets: PolymarketMarketPayload[],
  benchmarkSetId = DEFAULT_BENCHMARK_SET_ID,
): NormalizedPolymarketBenchmarkEntry[] {
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

    const normalizedOutcomes = outcomes.map((outcome) => outcome.trim().toLowerCase());
    const yesIndex = normalizedOutcomes.indexOf("yes");
    const tokenIds = parseTokenIdArray(market.clobTokenIds);
    const yesTokenId =
      yesIndex >= 0 && tokenIds.length === normalizedOutcomes.length
        ? (tokenIds[yesIndex] ?? null)
        : null;
    const marketSlug = market.market_slug ?? market.slug ?? primaryEvent?.slug;
    const marketUrl = marketSlug
      ? `https://polymarket.com/event/${marketSlug}`
      : `https://polymarket.com/event/${market.id}`;
    const scheduledEnd = market.endDate ?? market.endDateIso ?? market.end_date_iso ?? null;
    const startAt =
      market.startDate ??
      market.startDateIso ??
      primaryEvent?.startDate ??
      market.createdAt ??
      null;
    const theme = inferBenchmarkTheme(market, title, resolutionCriteria);

    if (
      !isStructurallyCompatibleBenchmarkMarket({
        market,
        title,
        resolutionCriteria,
        resolvedAt,
        startAt,
        theme,
      })
    ) {
      return [];
    }

    return [
      {
        market: BenchmarkMarketSchema.parse({
          id: market.id,
          benchmarkSetId,
          title,
          resolutionCriteria,
          theme,
          volume: coerceNumber(market.volume_num ?? market.volumeNum ?? market.volume),
          liquidity: coerceNumber(market.liquidity_num ?? market.liquidityNum ?? market.liquidity),
          resolvedAt: normalizeTimestamp(resolvedAt),
          endDate: scheduledEnd ? normalizeTimestamp(scheduledEnd) : null,
          resolvedValue,
          marketUrl,
        }),
        yesTokenId,
        startAt: startAt ? normalizeTimestamp(startAt) : null,
      },
    ];
  });
}

function filterRecentBenchmarkEntries(
  entries: NormalizedPolymarketBenchmarkEntry[],
  now: Date,
): NormalizedPolymarketBenchmarkEntry[] {
  const cutoffMillis = now.getTime() - RECENT_BENCHMARK_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  return entries.filter(
    (entry) => new Date(entry.market.resolvedAt).getTime() >= cutoffMillis,
  );
}

async function fetchPriceHistoryWindow(args: {
  clobBaseUrl: string;
  fetchImpl: typeof fetch;
  tokenId: string;
  startTs: number;
  endTs: number;
}): Promise<PolymarketPriceHistoryPoint[]> {
  const url = new URL("/prices-history", args.clobBaseUrl);
  url.searchParams.set("market", args.tokenId);
  url.searchParams.set("startTs", String(args.startTs));
  url.searchParams.set("endTs", String(args.endTs));
  url.searchParams.set("interval", "1h");
  url.searchParams.set("fidelity", String(HISTORY_FIDELITY_MINUTES));

  const response = await args.fetchImpl(url.toString());

  if (!response.ok) {
    throw new Error(
      `Polymarket price history import failed with ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as { history?: PolymarketPriceHistoryPoint[] };
  return Array.isArray(payload.history) ? payload.history : [];
}

async function fetchSnapshotAtCutoff(args: {
  clobBaseUrl: string;
  fetchImpl: typeof fetch;
  tokenId: string;
  cutoffAt: string;
  earliestAt: string | null;
}): Promise<number | null> {
  const earliestTs = args.earliestAt
    ? Math.floor(new Date(args.earliestAt).getTime() / 1000)
    : null;
  const cutoffTs = Math.floor(new Date(args.cutoffAt).getTime() / 1000);

  if (earliestTs !== null && earliestTs > cutoffTs) {
    return null;
  }

  let windowEndTs = cutoffTs;

  while (true) {
    const windowStartTs = Math.max(
      earliestTs ?? cutoffTs - HISTORY_LOOKBACK_WINDOW_SECONDS,
      windowEndTs - HISTORY_LOOKBACK_WINDOW_SECONDS,
    );
    const history = await fetchPriceHistoryWindow({
      clobBaseUrl: args.clobBaseUrl,
      fetchImpl: args.fetchImpl,
      tokenId: args.tokenId,
      startTs: windowStartTs,
      endTs: windowEndTs,
    });
    const latestPoint = history
      .filter((point) => Number.isFinite(point.p) && point.t <= cutoffTs)
      .sort((left, right) => right.t - left.t)[0];

    if (latestPoint) {
      return latestPoint.p;
    }

    if (windowStartTs <= (earliestTs ?? windowStartTs)) {
      return null;
    }

    windowEndTs = windowStartTs;
  }
}

async function buildBenchmarkPriceSnapshots(args: {
  entries: NormalizedPolymarketBenchmarkEntry[];
  clobBaseUrl: string;
  fetchImpl: typeof fetch;
}): Promise<BenchmarkPriceSnapshotInput[]> {
  const snapshots: BenchmarkPriceSnapshotInput[] = [];

  for (const entry of args.entries) {
    if (!entry.yesTokenId) {
      continue;
    }

    for (const cutoff of buildReplayCutoffs(entry.market.resolvedAt)) {
      const probability = await fetchSnapshotAtCutoff({
        clobBaseUrl: args.clobBaseUrl,
        fetchImpl: args.fetchImpl,
        tokenId: entry.yesTokenId,
        cutoffAt: cutoff.cutoffAt,
        earliestAt: entry.startAt,
      });

      if (probability === null) {
        continue;
      }

      snapshots.push({
        benchmarkMarketId: entry.market.id,
        cutoffAt: cutoff.cutoffAt,
        probability,
        volume: entry.market.volume,
        liquidity: entry.market.liquidity,
        source: "polymarket",
      });
    }
  }

  return snapshots;
}

async function fetchResolvedPolymarketMarkets(args: {
  baseUrl: string;
  fetchImpl: typeof fetch;
}): Promise<PolymarketMarketPayload[]> {
  const marketsById = new Map<string, PolymarketMarketPayload>();

  for (const pageRequest of RECENT_BENCHMARK_PAGE_REQUESTS) {
    const url = new URL("/markets", args.baseUrl);
    url.searchParams.set("closed", "true");
    url.searchParams.set("uma_resolution_status", "resolved");
    url.searchParams.set("order", "closedTime");
    url.searchParams.set("ascending", "false");
    url.searchParams.set("limit", String(pageRequest.limit));

    if (pageRequest.offset !== undefined) {
      url.searchParams.set("offset", String(pageRequest.offset));
    }

    const response = await args.fetchImpl(url.toString());

    if (!response.ok) {
      if (pageRequest.offset !== undefined) {
        continue;
      }

      throw new Error(`Polymarket import failed with ${response.status} ${response.statusText}`);
    }

    const pageMarkets = (await response.json()) as PolymarketMarketPayload[];

    for (const market of pageMarkets) {
      marketsById.set(market.id, market);
    }
  }

  return Array.from(marketsById.values());
}

export function normalizePolymarketBenchmarkMarkets(
  markets: PolymarketMarketPayload[],
  benchmarkSetId = DEFAULT_BENCHMARK_SET_ID,
): BenchmarkMarket[] {
  return normalizePolymarketBenchmarkEntries(markets, benchmarkSetId).map((entry) => entry.market);
}

export async function importResolvedPolymarketBenchmarks(args: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  benchmarkSetId?: string;
  mode?: "fixture" | "live";
  now?: Date;
}): Promise<BenchmarkMarket[]> {
  assertLiveEvaluationMode({
    CASSANDRA_ADAPTER_MODE: args.mode ?? "live",
  });

  const entries = filterRecentBenchmarkEntries(
    normalizePolymarketBenchmarkEntries(
      await fetchResolvedPolymarketMarkets({
        baseUrl: args.baseUrl,
        fetchImpl: args.fetchImpl ?? fetch,
      }),
      args.benchmarkSetId,
    ),
    args.now ?? new Date(),
  );
  return curateBenchmarkEntries(entries).map((entry) => entry.market);
}

export async function importAndStoreResolvedPolymarketBenchmarks(args: {
  pool: Pool;
  baseUrl: string;
  clobBaseUrl?: string;
  fetchImpl?: typeof fetch;
  benchmarkSetId?: string;
  mode?: "fixture" | "live";
  now?: Date;
}): Promise<BenchmarkMarket[]> {
  assertLiveEvaluationMode({
    CASSANDRA_ADAPTER_MODE: args.mode ?? "live",
  });

  const fetchImpl = args.fetchImpl ?? fetch;
  const entries = filterRecentBenchmarkEntries(
    normalizePolymarketBenchmarkEntries(
      await fetchResolvedPolymarketMarkets({
        baseUrl: args.baseUrl,
        fetchImpl,
      }),
      args.benchmarkSetId,
    ),
    args.now ?? new Date(),
  );
  const curatedEntries = curateBenchmarkEntries(entries);
  const insertedMarkets = await upsertBenchmarkMarkets(
    args.pool,
    curatedEntries.map((entry) => entry.market),
  );
  await syncBenchmarkMarkets(
    args.pool,
    args.benchmarkSetId ?? DEFAULT_BENCHMARK_SET_ID,
    curatedEntries.map((entry) => entry.market.id),
  );
  const snapshots = await buildBenchmarkPriceSnapshots({
    entries: curatedEntries,
    clobBaseUrl: args.clobBaseUrl ?? "https://clob.polymarket.com",
    fetchImpl,
  });
  await upsertBenchmarkPriceSnapshots(args.pool, snapshots);
  return insertedMarkets;
}
