import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";
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
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<OfficialPayload>("officialSearch", input.event.question)
          : {
              results: await searchWithPlannedQueries(
                search,
                {
                  count: 4,
                  providerName: "officialSearch",
                  query: `${input.event.question} ${input.event.entities.join(" ")} official press release investor relations announcement`,
                  recency: "oneYear",
                },
                input.queries,
                (query) => `${query} official statement`,
              ),
            };

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
