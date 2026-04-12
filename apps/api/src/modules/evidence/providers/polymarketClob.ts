import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface PolymarketClobPayload {
  prices: ProviderDocument[];
}

export function createPolymarketClobProvider(config: { baseUrl?: string } = {}): EvidenceProvider {
  return {
    name: "polymarketClob",
    async collect(input): Promise<EvidenceItem[]> {
      const baseUrl = config.baseUrl ?? "https://clob.polymarket.com";

      if (input.mode === "fixture") {
        const payload = await loadProviderFixture<PolymarketClobPayload>("polymarketClob", input.event.question);
        return payload.prices.map((document) =>
          createProviderEvidenceItem({
            eventId: input.event.id,
            sourceFamily: "prediction_market",
            sourceType: "quote_snapshot",
            document,
            metadata: { provider: "polymarketClob" },
          }),
        );
      }

      // The CLOB price endpoint requires a token_id from the Gamma market data.
      // Without a known token_id we cannot fetch pricing, so return empty.
      // The Gamma provider is responsible for discovering markets and returning
      // price metadata from outcomePrices. This provider supplements with
      // order-book depth when a polymarketMarketId resolves to a known token.
      if (!input.event.polymarketMarketId) {
        return [];
      }

      // Use the sampling-markets endpoint to get market details including token IDs
      try {
        const marketData = await fetchProviderJson<Record<string, unknown>>(
          `${baseUrl}/sampling-markets?condition_id=${encodeURIComponent(input.event.polymarketMarketId)}`,
        );

        const tokens = (marketData as Record<string, unknown>).tokens as
          | Array<Record<string, unknown>>
          | undefined;
        if (!tokens || tokens.length === 0) {
          return [];
        }

        const prices: ProviderDocument[] = [];
        for (const token of tokens) {
          const tokenId = String(token.token_id ?? "");
          if (!tokenId) continue;

          try {
            const priceData = await fetchProviderJson<{ price: number }>(
              `${baseUrl}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`,
            );
            prices.push({
              title: `${input.event.question} — ${String(token.outcome ?? "Yes")}`,
              url: `https://polymarket.com/event/${input.event.polymarketMarketId}`,
              publisher: "Polymarket CLOB",
              publishedAt: new Date().toISOString(),
              summary: `Current ${String(token.outcome ?? "Yes")} price: ${priceData.price}`,
              metadata: {
                provider: "polymarketClob",
                price: priceData.price,
                tokenId,
                outcome: token.outcome,
              },
              qualitySignals: {},
            });
          } catch {
            // Skip tokens with no pricing data
          }
        }

        return prices.map((document) =>
          createProviderEvidenceItem({
            eventId: input.event.id,
            sourceFamily: "prediction_market",
            sourceType: "quote_snapshot",
            document,
            metadata: { provider: "polymarketClob" },
          }),
        );
      } catch (error) {
        throw new Error(
          `polymarketClob failed for condition_id "${input.event.polymarketMarketId}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
