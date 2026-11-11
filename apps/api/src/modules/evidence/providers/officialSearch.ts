import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";
import { createSearchEvidenceItem } from "../sourceFamily.js";
import { createZaiWebSearch, searchWithPlannedQueries, type WebSearchFn } from "./webSearch.js";

interface OfficialPayload {
  results: Array<
    ProviderDocument & {
      sourceType?: "press_release" | "web_article";
    }
  >;
}

export function createOfficialSearchProvider(
  config: { zaiApiKey?: string; search?: WebSearchFn } = {},
): EvidenceProvider {
  const search = config.search ?? createZaiWebSearch(config.zaiApiKey);

  return {
    name: "officialSearch",
    async collect(input): Promise<EvidenceItem[]> {
      if (input.mode !== "fixture") {
        const results = await searchWithPlannedQueries(
          search,
          {
            count: 4,
            providerName: "officialSearch",
            query: `${input.event.question} ${input.event.entities.join(" ")} official press release investor relations announcement`,
            recency: "oneYear",
          },
          input.queries,
          (query) => `${query} official statement`,
        );

        // The query asks for official sources, but a search returns whatever ranks: each
        // result is labelled by where it was published.
        return results.map((document) =>
          createSearchEvidenceItem({ event: input.event, document, provider: "officialSearch", queryIntent: "official" }),
        );
      }

      const payload = await loadProviderFixture<OfficialPayload>("officialSearch", input.event.question);

      return payload.results.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "official",
          sourceType: "press_release",
          document,
          metadata: {
            provider: "officialSearch",
          },
        }),
      );
    },
  };
}
