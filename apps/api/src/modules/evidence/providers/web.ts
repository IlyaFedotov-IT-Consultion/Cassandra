import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface WebPayload {
  results: ProviderDocument[];
}

export function createWebProvider(config: { baseUrl?: string } = {}): EvidenceProvider {
  return {
    name: "web",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<WebPayload>("web", input.event.question)
          : await fetchProviderJson<WebPayload>(
              `${config.baseUrl ?? "https://example-web-search.local"}/search?q=${encodeURIComponent(input.event.question)}`,
            );

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
