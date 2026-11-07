import type { EvidenceItem } from "@cassandra/shared";

import type { EventRecord } from "../../events/repository.js";
import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface PolymarketGammaPayload {
  markets: ProviderDocument[];
}

interface GammaMarket {
  id?: string | number;
  question?: string;
  slug?: string;
  conditionId?: string;
  description?: string;
  outcomes?: string | string[];
  outcomePrices?: string | Array<string | number>;
  liquidityNum?: number | null;
  liquidity?: string | number | null;
  volumeNum?: number | null;
  volume?: string | number | null;
  spread?: number | null;
  closed?: boolean;
  endDate?: string;
}

interface GammaSearchResponse {
  events?: Array<{ title?: string; slug?: string; markets?: GammaMarket[] }>;
}

const MAX_SEARCH_MATCHES = 3;
const MIN_SHARED_TOKENS = 2;
const STOP_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "before", "by", "do", "does", "for",
  "from", "has", "have", "how", "if", "in", "into", "is", "it", "its", "of", "on", "or",
  "than", "that", "the", "their", "this", "to", "until", "what", "when", "which", "who",
  "will", "with", "would", "happen", "win", "get", "reach", "become", "announce", "say", "next",
]);

function contentTokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .map((token) => (token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token))
      // Bare numbers (years, thresholds) are shared by unrelated markets, so they never count.
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token)),
  );
}

function parseList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function yesProbability(market: GammaMarket): number | null {
  const outcomes = parseList(market.outcomes).map((outcome) => String(outcome).trim().toLowerCase());
  const prices = parseList(market.outcomePrices).map(toNumber);
  const yesIndex = outcomes.indexOf("yes");

  if (yesIndex === -1 || prices.length !== outcomes.length) {
    return null;
  }

  return prices[yesIndex] ?? null;
}

/** Gamma accepts numeric ids, condition ids (0x...) and slugs as distinct filters. */
function marketLookupQuery(identifier: string): string {
  if (/^0x[0-9a-f]+$/i.test(identifier)) {
    return `condition_ids=${encodeURIComponent(identifier)}`;
  }

  if (/^\d+$/.test(identifier)) {
    return `id=${encodeURIComponent(identifier)}`;
  }

  return `slug=${encodeURIComponent(identifier)}`;
}

function toDocument(
  market: GammaMarket,
  args: { matchedBy: "id" | "search"; matchedEntities: string[]; eventSlug?: string },
): ProviderDocument {
  const probability = yesProbability(market);
  const liquidity = toNumber(market.liquidityNum ?? market.liquidity);
  const question = String(market.question ?? "Polymarket market");
  const priceText = probability === null ? "unpriced" : `Yes price ${probability}`;
  const liquidityText = liquidity === null ? "unknown liquidity" : `liquidity $${Math.round(liquidity)}`;

  return {
    title: question,
    url: `https://polymarket.com/event/${args.eventSlug ?? market.slug ?? market.id ?? ""}`,
    publisher: "Polymarket",
    // A market quote is an observation at retrieval time, not an article publication date.
    publishedAt: new Date().toISOString(),
    summary: `${question} ${priceText} (${liquidityText}).`,
    claims: [],
    entities: args.matchedEntities,
    stance: "unknown",
    metadata: {
      provider: "polymarketGamma",
      polymarketId: market.id === undefined ? null : String(market.id),
      conditionId: market.conditionId ?? null,
      slug: market.slug ?? null,
      outcomes: market.outcomes ?? null,
      outcomePrices: market.outcomePrices ?? null,
      probability,
      liquidity,
      volume: toNumber(market.volumeNum ?? market.volume),
      spread: toNumber(market.spread),
      endDate: market.endDate ?? null,
      matchedBy: args.matchedBy,
    },
    qualitySignals: {},
  };
}

function scoreMarket(event: EventRecord, market: GammaMarket, eventTitle: string) {
  const marketText = `${market.question ?? ""} ${eventTitle}`.toLowerCase();
  const matchedEntities = event.entities.filter((entity) => {
    const normalized = entity.trim().toLowerCase();
    return normalized.length >= 3 && marketText.includes(normalized);
  });
  const eventTokens = contentTokens(`${event.question} ${event.entities.join(" ")}`);
  const marketTokens = contentTokens(marketText);
  const sharedTokens = [...eventTokens].filter((token) => marketTokens.has(token)).length;

  return { matchedEntities, sharedTokens };
}

async function lookupConfiguredMarket(baseUrl: string, identifier: string): Promise<GammaMarket[]> {
  const query = marketLookupQuery(identifier);
  const open = await fetchProviderJson<GammaMarket[]>(`${baseUrl}/markets?${query}`);

  if (Array.isArray(open) && open.length > 0) {
    return open;
  }

  // Gamma hides closed markets unless asked explicitly.
  const closed = await fetchProviderJson<GammaMarket[]>(`${baseUrl}/markets?${query}&closed=true`);
  return Array.isArray(closed) ? closed : [];
}

async function searchRelatedMarkets(baseUrl: string, event: EventRecord): Promise<ProviderDocument[]> {
  const query = encodeURIComponent(event.question.replace(/\?+$/, ""));
  const response = await fetchProviderJson<GammaSearchResponse>(
    `${baseUrl}/public-search?q=${query}&limit_per_type=5&events_status=active`,
  );
  const candidates = (response.events ?? []).flatMap((searchEvent) =>
    (searchEvent.markets ?? [])
      .filter((market) => market.closed !== true && market.question)
      .map((market) => ({
        market,
        eventSlug: searchEvent.slug,
        ...scoreMarket(event, market, searchEvent.title ?? ""),
      })),
  );

  return candidates
    .filter((candidate) => candidate.matchedEntities.length > 0 || candidate.sharedTokens >= MIN_SHARED_TOKENS)
    .sort(
      (left, right) =>
        right.matchedEntities.length - left.matchedEntities.length ||
        right.sharedTokens - left.sharedTokens ||
        (toNumber(right.market.liquidityNum) ?? 0) - (toNumber(left.market.liquidityNum) ?? 0),
    )
    .slice(0, MAX_SEARCH_MATCHES)
    .map((candidate) =>
      toDocument(candidate.market, {
        matchedBy: "search",
        matchedEntities: candidate.matchedEntities,
        eventSlug: candidate.eventSlug,
      }),
    );
}

export function createPolymarketGammaProvider(config: { baseUrl?: string } = {}): EvidenceProvider {
  return {
    name: "polymarketGamma",
    async collect(input): Promise<EvidenceItem[]> {
      const baseUrl = config.baseUrl ?? "https://gamma-api.polymarket.com";
      const toEvidence = (document: ProviderDocument) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "prediction_market",
          sourceType: "polymarket_market",
          document,
          metadata: { provider: "polymarketGamma" },
        });

      if (input.mode === "fixture") {
        const payload = await loadProviderFixture<PolymarketGammaPayload>("polymarketGamma", input.event.question);
        return payload.markets.map(toEvidence);
      }

      if (input.event.polymarketMarketId) {
        const markets = await lookupConfiguredMarket(baseUrl, input.event.polymarketMarketId);

        if (markets.length > 0) {
          return markets.map((market) =>
            toEvidence(toDocument(market, { matchedBy: "id", matchedEntities: input.event.entities })),
          );
        }
      }

      return (await searchRelatedMarkets(baseUrl, input.event)).map(toEvidence);
    },
  };
}
