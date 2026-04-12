import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";
import { searchWithZaiCli } from "./zaiCli.js";

interface OfficialPayload {
  results: Array<
    ProviderDocument & {
      sourceType?: "press_release" | "web_article";
    }
  >;
}

export function createOfficialSearchProvider(config: { zaiApiKey?: string } = {}): EvidenceProvider {
  return {
    name: "officialSearch",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<OfficialPayload>("officialSearch", input.event.question)
          : {
              results: await searchWithZaiCli({
                apiKey: config.zaiApiKey,
                count: 4,
                providerName: "officialSearch",
                query: `${input.event.question} ${input.event.entities.join(" ")} official press release investor relations announcement`,
                recency: "oneYear",
              }),
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
