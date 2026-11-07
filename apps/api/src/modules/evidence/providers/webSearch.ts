import type { ProviderDocument } from "./fixtureLoader.js";
import { searchWithOpenRouter } from "./openRouterSearch.js";
import { searchWithZaiCli } from "./zaiCli.js";

export type SearchRecency = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";

export interface WebSearchRequest {
  providerName: string;
  query: string;
  /** Total results wanted. */
  count?: number;
  /** Domain restriction; wildcards such as "*.gov" are honoured by OpenRouter. */
  domains?: string[];
  recency?: SearchRecency;
}

/** One search backend behind every live search-based evidence provider. */
export type WebSearchFn = (request: WebSearchRequest) => Promise<ProviderDocument[]>;

export function createZaiWebSearch(apiKey: string | undefined): WebSearchFn {
  return (request) =>
    searchWithZaiCli({
      apiKey,
      providerName: request.providerName,
      query: request.query,
      // Z.AI filters one domain per request, so its count is per domain.
      count: request.domains && request.domains.length > 0
        ? Math.max(1, Math.ceil((request.count ?? 5) / request.domains.length))
        : request.count,
      domains: request.domains,
      recency: request.recency,
    });
}

export function createOpenRouterWebSearch(config: {
  apiKey: string;
  model?: string;
  engine?: string;
}): WebSearchFn {
  return (request) =>
    searchWithOpenRouter({
      apiKey: config.apiKey,
      model: config.model,
      engine: config.engine,
      providerName: request.providerName,
      query: request.query,
      count: request.count,
      domains: request.domains,
    });
}

export const MAX_PLANNED_QUERIES_PER_PROVIDER = 2;

/**
 * Run a provider's own query plus up to MAX_PLANNED_QUERIES_PER_PROVIDER planned
 * sub-question queries concurrently, keeping results in query order and dropping repeated
 * URLs. Planned queries are best effort: only a failure of every query fails the provider.
 */
export async function searchWithPlannedQueries(
  search: WebSearchFn,
  base: WebSearchRequest,
  plannedQueries: string[] | undefined,
  decorate: (query: string) => string = (query) => query,
): Promise<ProviderDocument[]> {
  const requests: WebSearchRequest[] = [
    base,
    ...(plannedQueries ?? [])
      .filter((query) => query.trim().length > 0)
      .slice(0, MAX_PLANNED_QUERIES_PER_PROVIDER)
      .map((query) => ({
        ...base,
        query: decorate(query.trim()),
        count: Math.max(2, Math.ceil((base.count ?? 5) / 2)),
      })),
  ];
  const settled = await Promise.allSettled(requests.map((request) => search(request)));
  const fulfilled = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

  if (fulfilled.length === 0) {
    const firstFailure = settled.find((result) => result.status === "rejected");
    throw firstFailure && firstFailure.status === "rejected" ? firstFailure.reason : new Error("search failed");
  }

  const seen = new Set<string>();
  return fulfilled.flat().filter((document) => {
    if (seen.has(document.url)) {
      return false;
    }
    seen.add(document.url);
    return true;
  });
}
