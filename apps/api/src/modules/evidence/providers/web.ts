import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  loadProviderFixture,
} from "./fixtureLoader.js";
import { searchWithZaiCli } from "./zaiCli.js";

interface WebPayload {
  results: Awaited<ReturnType<typeof searchWithZaiCli>>;
}

export function createWebProvider(config: { zaiApiKey?: string } = {}): EvidenceProvider {
  return {
    name: "web",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<WebPayload>("web", input.event.question)
          : {
              results: await searchWithZaiCli({
                apiKey: config.zaiApiKey,
                count: 5,
                providerName: "web",
                query: `${input.event.question} ${input.event.entities.join(" ")} latest reporting analysis in English`,
                recency: "oneYear",
              }),
            };

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
