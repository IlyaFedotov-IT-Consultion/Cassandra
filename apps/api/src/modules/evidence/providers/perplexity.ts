import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface PerplexityPayload {
  results: ProviderDocument[];
}

export function createPerplexityProvider(config: {
  baseUrl?: string;
  apiKey?: string;
} = {}): EvidenceProvider {
  return {
    name: "perplexity",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<PerplexityPayload>("perplexity", input.event.question)
          : await fetchProviderJson<PerplexityPayload>(
              `${config.baseUrl ?? "https://api.perplexity.ai"}/search?q=${encodeURIComponent(input.event.question)}`,
              {
                headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
              },
            );

      return payload.results.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "llm_research",
          sourceType: "perplexity_search_result",
          document,
          metadata: {
            provider: "perplexity",
          },
        }),
      );
    },
  };
}
