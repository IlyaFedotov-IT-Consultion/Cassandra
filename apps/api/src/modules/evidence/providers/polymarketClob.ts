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
      const marketId = input.event.polymarketMarketId ?? input.event.question;
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<PolymarketClobPayload>("polymarketClob", input.event.question)
          : await fetchProviderJson<PolymarketClobPayload>(
              `${config.baseUrl ?? "https://clob.polymarket.com"}/markets/${encodeURIComponent(marketId)}`,
            );

      return payload.prices.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "prediction_market",
          sourceType: "quote_snapshot",
          document,
          metadata: {
            provider: "polymarketClob",
          },
        }),
      );
    },
  };
}
