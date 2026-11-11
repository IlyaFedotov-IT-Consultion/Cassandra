import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  loadProviderFixture,
} from "./fixtureLoader.js";
import type { ProviderDocument } from "./fixtureLoader.js";
import { createSearchEvidenceItem } from "../sourceFamily.js";
import { createZaiWebSearch, searchWithPlannedQueries, type WebSearchFn } from "./webSearch.js";

interface WebPayload {
  results: ProviderDocument[];
}

export function createWebProvider(
  config: { zaiApiKey?: string; search?: WebSearchFn } = {},
): EvidenceProvider {
  const search = config.search ?? createZaiWebSearch(config.zaiApiKey);

  return {
    name: "web",
    async collect(input): Promise<EvidenceItem[]> {
      if (input.mode !== "fixture") {
        const results = await searchWithPlannedQueries(
          search,
          {
            count: 5,
            providerName: "web",
            query: `${input.event.question} ${input.event.entities.join(" ")} latest reporting analysis in English`,
            recency: "oneYear",
          },
          input.queries,
        );

        return results.map((document) =>
          createSearchEvidenceItem({ event: input.event, document, provider: "web", queryIntent: "web" }),
        );
      }

      const payload = await loadProviderFixture<WebPayload>("web", input.event.question);

      return payload.results.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "web",
          sourceType: "web_article",
          document,
          metadata: {
            provider: "web",
          },
        }),
      );
    },
  };
}
