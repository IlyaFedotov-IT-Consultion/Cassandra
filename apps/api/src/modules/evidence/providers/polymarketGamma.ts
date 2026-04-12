import type { EvidenceItem } from "@cassandra/shared";

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

export function createPolymarketGammaProvider(config: { baseUrl?: string } = {}): EvidenceProvider {
  return {
    name: "polymarketGamma",
    async collect(input): Promise<EvidenceItem[]> {
      const baseUrl = config.baseUrl ?? "https://gamma-api.polymarket.com";

      if (input.mode === "fixture") {
        const payload = await loadProviderFixture<PolymarketGammaPayload>("polymarketGamma", input.event.question);
        return payload.markets.map((document) =>
          createProviderEvidenceItem({
            eventId: input.event.id,
            sourceFamily: "prediction_market",
            sourceType: "polymarket_market",
            document,
            metadata: { provider: "polymarketGamma" },
          }),
        );
      }

      // Try slug-based lookup first when a polymarketMarketId is available
      if (input.event.polymarketMarketId) {
        const slug = input.event.polymarketMarketId;
        try {
          const payload = await fetchProviderJson<PolymarketGammaPayload>(
            `${baseUrl}/markets?slug=${encodeURIComponent(slug)}&limit=5`,
          );
          if (payload.markets && payload.markets.length > 0) {
            return payload.markets.map((document) =>
              createProviderEvidenceItem({
                eventId: input.event.id,
                sourceFamily: "prediction_market",
                sourceType: "polymarket_market",
                document,
                metadata: { provider: "polymarketGamma" },
              }),
            );
          }
        } catch {
          // Slug lookup failed; fall through to text search
        }
      }

      // Text search fallback using the public search endpoint
      const query = input.event.question;
      const searchResults = await fetchProviderJson<Array<Record<string, unknown>>>(
        `${baseUrl}/public-search?query=${encodeURIComponent(query)}&limit=5`,
      );

      const markets: ProviderDocument[] = [];
      for (const result of searchResults) {
        const market = ((result as Record<string, unknown>).market ?? result) as Record<string, unknown>;
        markets.push({
          title: String(market.question ?? market.title ?? ""),
          url: String(market.url ?? `https://polymarket.com/event/${market.slug ?? ""}`),
          publisher: "Polymarket",
          publishedAt: String(market.startDate ?? market.createdAt ?? new Date().toISOString()),
          summary: String(market.description ?? market.question ?? ""),
          claims: [],
          entities: input.event.entities,
          stance: "unknown",
          metadata: {
            provider: "polymarketGamma",
            polymarketId: market.id,
            outcomePrices: market.outcomePrices,
            volume: market.volume,
            liquidity: market.liquidity,
          },
          qualitySignals: {},
        });
      }

      return markets.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "prediction_market",
          sourceType: "polymarket_market",
          document,
          metadata: { provider: "polymarketGamma" },
        }),
      );
    },
  };
}
