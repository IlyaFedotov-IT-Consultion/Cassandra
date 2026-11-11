import type { EvidenceItem } from "@cassandra/shared";

import { classifySource } from "../sourceFamily.js";
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
  apiKey?: string;
  baseUrl?: string;
} = {}): EvidenceProvider {
  return {
    name: "perplexity",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<PerplexityPayload>("perplexity", input.event.question)
          : await fetchProviderJson<PerplexityPayload>(
              `${config.baseUrl ?? "https://api.perplexity.ai"}/search`,
              {
                body: JSON.stringify({
                  max_results: 5,
                  query: `${input.event.question} (prioritize English-language sources)`,
                }),
                headers: {
                  ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
                  "content-type": "application/json",
                },
                method: "POST",
              },
            );

      return payload.results.map((document) => {
        // A government, official or community page is that, whoever found it. Everything
        // else stays research material for the open-web judge.
        const classified = input.mode === "fixture" ? null : classifySource(document.url, input.event.entities);
        const recognised = classified && classified.sourceFamily !== "web" ? classified : null;

        return createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: recognised?.sourceFamily ?? "llm_research",
          sourceType: recognised?.sourceType ?? "perplexity_search_result",
          document,
          metadata: {
            provider: "perplexity",
          },
        });
      });
    },
  };
}
