import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProviderDocument } from "./fixtureLoader.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;

type ZaiCliRecency = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";

interface ZaiCliResult {
  title?: string;
  url?: string;
  summary?: string;
  source?: string;
  date?: string;
}

function normalizePublishedAt(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = value.length === 10 ? `${value}T00:00:00Z` : value;
  const date = new Date(parsed);

  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export async function searchWithZaiCli(args: {
  apiKey?: string;
  count?: number;
  domains?: string[];
  location?: "cn" | "us";
  providerName: string;
  query: string;
  recency?: ZaiCliRecency;
  timeoutMs?: number;
}): Promise<ProviderDocument[]> {
  if (!args.apiKey) {
    throw new Error(`Missing ZAI_API_KEY for provider ${args.providerName}`);
  }

  const domains = args.domains && args.domains.length > 0 ? args.domains : [undefined];
  const documents: ProviderDocument[] = [];
  const seenUrls = new Set<string>();

  for (const domain of domains) {
    const cliArgs = ["-y", "zai-cli", "search", args.query];

    if (domain) {
      cliArgs.push("--domain", domain);
    }

    if (args.recency) {
      cliArgs.push("--recency", args.recency);
    }

    if (args.location) {
      cliArgs.push("--location", args.location);
    }

    cliArgs.push("--count", String(args.count ?? 5));

    const { stdout } = await execFileAsync("npx", cliArgs, {
      env: {
        ...process.env,
        ZAI_API_KEY: args.apiKey,
        Z_AI_API_KEY: args.apiKey,
      },
      maxBuffer: 1024 * 1024 * 4,
      timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const parsed = JSON.parse(stdout) as ZaiCliResult[];

    for (const item of parsed) {
      const url = item.url?.trim();

      if (!url || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      documents.push({
        title: item.title?.trim() || item.summary?.trim() || url,
        url,
        publisher: item.source?.trim() || domain || "zai-cli-search",
        publishedAt: normalizePublishedAt(item.date),
        summary: item.summary?.trim() || item.title?.trim() || url,
        metadata: {
          provider: args.providerName,
          domain: domain ?? null,
        },
        qualitySignals: {
          domainFiltered: Boolean(domain),
        },
      });
    }
  }

  return documents;
}
