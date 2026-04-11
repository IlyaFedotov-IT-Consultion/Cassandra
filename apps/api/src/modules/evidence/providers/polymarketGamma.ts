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
      const marketId = input.event.polymarketMarketId ?? input.event.question;
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<PolymarketGammaPayload>("polymarketGamma", input.event.question)
          : await fetchProviderJson<PolymarketGammaPayload>(
              `${config.baseUrl ?? "https://gamma-api.polymarket.com"}/markets/${encodeURIComponent(marketId)}`,
            );

      return payload.markets.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "prediction_market",
          sourceType: "polymarket_market",
          document,
          metadata: {
            provider: "polymarketGamma",
          },
        }),
      );
    },
  };
}
