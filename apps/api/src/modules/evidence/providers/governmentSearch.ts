import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  loadProviderFixture,
} from "./fixtureLoader.js";
import type { ProviderDocument } from "./fixtureLoader.js";
import { createZaiWebSearch, searchWithPlannedQueries, type WebSearchFn } from "./webSearch.js";

interface GovernmentPayload {
  results: ProviderDocument[];
}

export const DEFAULT_GOVERNMENT_DOMAINS = ["fda.gov", "sec.gov", "europa.eu"];

export function createGovernmentSearchProvider(
  config: { zaiApiKey?: string; search?: WebSearchFn; domains?: string[] } = {},
): EvidenceProvider {
  const search = config.search ?? createZaiWebSearch(config.zaiApiKey);
  const domains = config.domains ?? DEFAULT_GOVERNMENT_DOMAINS;

  return {
    name: "governmentSearch",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<GovernmentPayload>("governmentSearch", input.event.question)
          : {
              results: await searchWithPlannedQueries(
                search,
                {
                  count: 9,
                  domains,
                  providerName: "governmentSearch",
                  query: `${input.event.question} ${input.event.entities.join(" ")} regulator government notice official filing`,
                  recency: "oneYear",
                },
                input.queries,
              ),
            };

      return payload.results.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "government",
          sourceType: "government_notice",
          document,
          metadata: {
            provider: "governmentSearch",
          },
        }),
      );
    },
  };
}
