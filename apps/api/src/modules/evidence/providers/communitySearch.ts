import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  fetchProviderJson,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";

interface CommunityPayload {
  posts: Array<
    ProviderDocument & {
      postType?: "reddit_post" | "x_post";
    }
  >;
}

export function createCommunitySearchProvider(config: { baseUrl?: string } = {}): EvidenceProvider {
  return {
    name: "communitySearch",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<CommunityPayload>("communitySearch", input.event.question)
          : await fetchProviderJson<CommunityPayload>(
              `${config.baseUrl ?? "https://example-community-search.local"}/search?q=${encodeURIComponent(input.event.question)}`,
            );

      return payload.posts.map((document) =>
        createProviderEvidenceItem({
          eventId: input.event.id,
          sourceFamily: "community",
          sourceType: document.postType ?? "reddit_post",
          document,
          metadata: {
            provider: "communitySearch",
          },
        }),
      );
    },
  };
}
