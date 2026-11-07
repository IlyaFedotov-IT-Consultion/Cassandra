import type { ProviderDocument } from "./fixtureLoader.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const DEFAULT_ENGINE = "perplexity";
const DEFAULT_TIMEOUT_MS = 60_000;
const SUMMARY_MAX_CHARS = 600;
const DATE_SCAN_CHARS = 400;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

export interface OpenRouterSearchArgs {
  apiKey: string;
  providerName: string;
  query: string;
  count?: number;
  domains?: string[];
  engine?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Retrieval timestamp; also the upper bound for any inferred publication date. */
  retrievedAt?: string;
}

interface UrlCitation {
  url?: string;
  title?: string;
  content?: string;
}

function utcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
    ? date
    : null;
}

function datesInUrl(url: string): Date[] {
  const dates: Date[] = [];
  for (const match of url.matchAll(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/g)) {
    const date = utcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date) dates.push(date);
  }
  for (const match of url.matchAll(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/g)) {
    const date = utcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date) dates.push(date);
  }
  return dates;
}

function datesInText(text: string): Date[] {
  const head = text.slice(0, DATE_SCAN_CHARS);
  const dates: Date[] = [];
  for (const match of head.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    const date = utcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date) dates.push(date);
  }
  for (const match of head.matchAll(/\b([A-Z][a-z]{2,8})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/g)) {
    const month = MONTHS[(match[1] ?? "").toLowerCase().slice(0, 4)] ?? MONTHS[(match[1] ?? "").toLowerCase().slice(0, 3)];
    const date = month === undefined ? null : utcDate(Number(match[3]), month, Number(match[2]));
    if (date) dates.push(date);
  }
  return dates;
}

/**
 * Search results carry no publication date, so infer one: URL dates first, then dates in
 * the opening text. Dates after retrieval are discarded, and the latest remaining date is
 * used: a source cannot predate the newest date it mentions, so this errs toward
 * excluding evidence from historical replays rather than leaking it in.
 */
function inferPublishedAt(
  citation: Required<Pick<UrlCitation, "url">> & UrlCitation,
  retrievedAt: Date,
): { publishedAt: string; source: "url" | "content" | "unknown" } {
  const notFuture = (date: Date) => date.getTime() <= retrievedAt.getTime();
  const latest = (dates: Date[]) =>
    dates.filter(notFuture).sort((left, right) => right.getTime() - left.getTime())[0];
  const fromUrl = latest(datesInUrl(citation.url));
  if (fromUrl) {
    return { publishedAt: fromUrl.toISOString(), source: "url" };
  }
  const fromContent = latest(datesInText(citation.content ?? ""));
  if (fromContent) {
    return { publishedAt: fromContent.toISOString(), source: "content" };
  }
  return { publishedAt: retrievedAt.toISOString(), source: "unknown" };
}

function normalizeSummary(content: string | undefined, fallback: string): string {
  const text = (content ?? "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, SUMMARY_MAX_CHARS);
}

/**
 * Web search through OpenRouter's `web` plugin. URLs and excerpts come from the search
 * engine (default: Perplexity Search API), not from model generation, so they cannot be
 * hallucinated; the chat completion itself is discarded.
 */
export async function searchWithOpenRouter(args: OpenRouterSearchArgs): Promise<ProviderDocument[]> {
  if (!args.apiKey) {
    throw new Error(`Missing OPENROUTER_API_KEY for provider ${args.providerName}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retrievedAt = new Date(args.retrievedAt ?? new Date().toISOString());

  try {
    const response = await fetch(`${args.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
        "X-Title": "Cassandra Evidence Search",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: args.model ?? DEFAULT_MODEL,
        messages: [{ role: "user", content: args.query }],
        max_tokens: 16,
        plugins: [
          {
            id: "web",
            engine: args.engine ?? DEFAULT_ENGINE,
            max_results: args.count ?? 5,
            ...(args.domains && args.domains.length > 0 ? { include_domains: args.domains } : {}),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter web search failed with ${response.status} ${response.statusText}: ${errorText.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { annotations?: Array<{ type?: string; url_citation?: UrlCitation }> } }>;
    };
    const annotations = payload.choices?.[0]?.message?.annotations ?? [];
    const seen = new Set<string>();
    const documents: ProviderDocument[] = [];

    for (const annotation of annotations) {
      const citation = annotation.url_citation;
      const url = citation?.url?.trim();
      if (annotation.type !== "url_citation" || !citation || !url || seen.has(url)) {
        continue;
      }
      seen.add(url);

      let publisher: string;
      try {
        publisher = new URL(url).hostname;
      } catch {
        continue;
      }

      const title = citation.title?.replace(/\s+/g, " ").trim() || url;
      const dated = inferPublishedAt({ ...citation, url }, retrievedAt);
      documents.push({
        title,
        url,
        publisher,
        publishedAt: dated.publishedAt,
        summary: normalizeSummary(citation.content, title),
        metadata: {
          provider: args.providerName,
          searchBackend: "openrouter",
          searchEngine: args.engine ?? DEFAULT_ENGINE,
          publishedAtSource: dated.source,
          domains: args.domains ?? null,
        },
        qualitySignals: {
          domainFiltered: Boolean(args.domains && args.domains.length > 0),
        },
      });
    }

    return documents;
  } finally {
    clearTimeout(timeout);
  }
}
