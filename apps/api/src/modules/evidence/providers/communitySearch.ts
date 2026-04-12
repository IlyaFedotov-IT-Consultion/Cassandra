import type { EvidenceItem } from "@cassandra/shared";

import type { EvidenceProvider } from "../types.js";
import {
  createProviderEvidenceItem,
  loadProviderFixture,
  type ProviderDocument,
} from "./fixtureLoader.js";
import { searchWithZaiCli } from "./zaiCli.js";

interface CommunityPayload {
  posts: Array<
    ProviderDocument & {
      postType?: "reddit_post" | "x_post";
    }
  >;
}

export function createCommunitySearchProvider(config: { zaiApiKey?: string } = {}): EvidenceProvider {
  return {
    name: "communitySearch",
    async collect(input): Promise<EvidenceItem[]> {
      const payload =
        input.mode === "fixture"
          ? await loadProviderFixture<CommunityPayload>("communitySearch", input.event.question)
          : {
              posts: (
                await searchWithZaiCli({
                  apiKey: config.zaiApiKey,
                  count: 3,
                  domains: ["reddit.com", "x.com"],
                  providerName: "communitySearch",
                  query: `${input.event.question} ${input.event.entities.join(" ")} discussion reactions rumor`,
                  recency: "oneMonth",
                })
              ).map((document) => ({
                ...document,
                postType: document.url.includes("x.com") ? "x_post" as const : "reddit_post" as const,
              })),
            };

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
