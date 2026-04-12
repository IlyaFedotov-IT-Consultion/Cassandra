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

      const marketsResponse = await fetchProviderJson<Array<Record<string, unknown>>>(
        `${baseUrl}/markets?limit=5&closed=false&order=volume&ascending=false`,
      );

      const markets: ProviderDocument[] = [];
      for (const market of marketsResponse) {
        const question = String(market.question ?? "");
        const eventQuestion = input.event.question.toLowerCase();
        const hasOverlap = input.event.entities.some(
          (entity) => question.toLowerCase().includes(entity.toLowerCase()),
        ) || eventQuestion.split(/\s+/).filter((w) => w.length > 3).some(
          (word) => question.toLowerCase().includes(word),
        );
        if (!hasOverlap) continue;

        markets.push({
          title: question,
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
