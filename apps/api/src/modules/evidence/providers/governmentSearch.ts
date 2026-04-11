import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface GovernmentPayload {
  results: ProviderDocument[];
}

export function createGovernmentSearchProvider(config: { baseUrl?: string } = {}): EvidenceProvider {
  return {
    name: "governmentSearch",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<GovernmentPayload>("governmentSearch", input.event.question)
          : await fetchProviderJson<GovernmentPayload>(
              `${config.baseUrl ?? "https://example-government-search.local"}/search?q=${encodeURIComponent(input.event.question)}`,
            );

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
