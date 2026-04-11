import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface OfficialPayload {
  results: Array<
    ProviderDocument & {
      sourceType?: "press_release" | "web_article";
    }
  >;
}

export function createOfficialSearchProvider(config: { baseUrl?: string } = {}): EvidenceProvider {
  return {
    name: "officialSearch",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<OfficialPayload>("officialSearch", input.event.question)
          : await fetchProviderJson<OfficialPayload>(
              `${config.baseUrl ?? "https://example-official-search.local"}/search?q=${encodeURIComponent(input.event.question)}`,
            );

      return payload.results.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "official",
          sourceType: document.sourceType ?? "press_release",
          document,
          metadata: {
            provider: "officialSearch",
          },
        }),
      );
    },
  };
}
