import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  loadProviderFixture,
} from "./fixtureLoader.js";
import { searchWithZaiCli } from "./zaiCli.js";

interface GovernmentPayload {
  results: Awaited<ReturnType<typeof searchWithZaiCli>>;
}

export function createGovernmentSearchProvider(config: { zaiApiKey?: string } = {}): EvidenceProvider {
  return {
    name: "governmentSearch",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<GovernmentPayload>("governmentSearch", input.event.question)
          : {
              results: await searchWithZaiCli({
                apiKey: config.zaiApiKey,
                count: 3,
                domains: ["fda.gov", "sec.gov", "europa.eu"],
                providerName: "governmentSearch",
                query: `${input.event.question} ${input.event.entities.join(" ")} regulator government notice official filing`,
                recency: "oneYear",
              }),
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
