import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface MarketQuoteDocument extends ProviderDocument {
  headline?: string;
  symbol?: string;
}

interface MarketProviderPayload {
  quotes: MarketQuoteDocument[];
}

export function createMarketProvider(config: {
  baseUrl?: string;
  apiKey?: string;
} = {}): EvidenceProvider {
  return {
    name: "marketProvider",
    async collect(input): Promise<EvidenceItem[]> {
      const symbols = input.event.marketSymbols.join(",");
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<MarketProviderPayload>("marketProvider", input.event.question)
          : await fetchProviderJson<MarketProviderPayload>(
              `${config.baseUrl ?? "https://example-market-provider.local"}/quotes?symbols=${encodeURIComponent(symbols)}`,
              {
                headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
              },
            );

      return payload.quotes.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "market",
          sourceType: "quote_snapshot",
          document: {
            ...document,
            title: document.title ?? document.headline ?? document.summary,
          },
          metadata: {
            provider: "marketProvider",
            symbol: document.symbol ?? null,
          },
        }),
      );
    },
  };
}
