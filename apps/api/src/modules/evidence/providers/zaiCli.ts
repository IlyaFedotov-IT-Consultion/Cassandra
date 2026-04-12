import type { ProviderDocument } from "./fixtureLoader.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ZAI_WEB_SEARCH_URL = "https://api.z.ai/api/paas/v4/web_search";

type ZaiCliRecency = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";

interface ZaiWebSearchResult {
  title?: string;
  link?: string;
  content?: string;
  media?: string;
  publish_date?: string;
}

interface ZaiWebSearchResponse {
  search_result?: ZaiWebSearchResult[];
}

function normalizePublishedAt(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = value.length === 10 ? `${value}T00:00:00Z` : value;
  const date = new Date(parsed);

  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function resolveSearchUrl(searchUrl?: string): string {
  return searchUrl ?? process.env.ZAI_WEB_SEARCH_URL ?? DEFAULT_ZAI_WEB_SEARCH_URL;
}

export async function searchWithZaiCli(args: {
  apiKey?: string;
  count?: number;
  domains?: string[];
  location?: "cn" | "us";
  providerName: string;
  query: string;
  recency?: ZaiCliRecency;
  searchEngine?: string;
  searchUrl?: string;
  timeoutMs?: number;
}): Promise<ProviderDocument[]> {
  if (!args.apiKey) {
    throw new Error(`Missing ZAI_API_KEY for provider ${args.providerName}`);
  }

  const domains = args.domains && args.domains.length > 0 ? args.domains : [undefined];
  const documents: ProviderDocument[] = [];
  const seenUrls = new Set<string>();

  for (const domain of domains) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(resolveSearchUrl(args.searchUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          search_engine: args.searchEngine ?? "search-std",
          search_query: args.query,
          count: args.count ?? 5,
          search_domain_filter: domain,
          search_recency_filter: args.recency ?? "noLimit",
          location: args.location ?? "us",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Z.AI web search failed with ${response.status} ${response.statusText}: ${errorText.slice(0, 500)}`,
        );
      }

      const payload = (await response.json()) as ZaiWebSearchResponse;

      for (const item of payload.search_result ?? []) {
        const url = item.link?.trim();

        if (!url || seenUrls.has(url)) {
          continue;
        }

        seenUrls.add(url);
        documents.push({
          title: item.title?.trim() || item.content?.trim() || url,
          url,
          publisher: item.media?.trim() || domain || "zai-web-search",
          publishedAt: normalizePublishedAt(item.publish_date),
          summary: item.content?.trim() || item.title?.trim() || url,
          metadata: {
            provider: args.providerName,
            domain: domain ?? null,
          },
          qualitySignals: {
            domainFiltered: Boolean(domain),
          },
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return documents;
}
