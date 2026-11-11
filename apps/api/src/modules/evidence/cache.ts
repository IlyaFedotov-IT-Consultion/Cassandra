import { createHash } from "node:crypto";

import type { EvidenceItem } from "@cassandra/shared";
import type { Redis } from "ioredis";

import type { AppLogger } from "../../lib/logger.js";
import type { EventRecord } from "../events/repository.js";
import { normalizeEvidenceItems } from "./normalize.js";
import { insertEvidenceItems } from "./repository.js";
import type { CollectEvidenceArgs, CollectEvidenceResult, ProviderRun } from "./types.js";

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface EvidenceCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class InMemoryEvidenceCacheStore implements EvidenceCacheStore {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

export function createRedisEvidenceCacheStore(redis: Redis): EvidenceCacheStore {
  return {
    async get(key: string) {
      return redis.get(key);
    },
    async set(key: string, value: string, ttlSeconds: number) {
      await redis.set(key, value, "EX", ttlSeconds);
    },
  };
}

export function buildEvidenceCacheKey(
  question: string,
  evaluationTime: string,
  providerName: string,
): string {
  const hourBucket = new Date(evaluationTime).toISOString().slice(0, 13);
  const canonicalQuestion = question.trim().toLowerCase().replace(/\s+/g, " ");
  return `evidence:${providerName}:${hourBucket}:${canonicalQuestion}`;
}

/**
 * Providers query by question *and* by the event's market binding, entities and symbols,
 * so all of them belong in the cache key; otherwise events that share a question would
 * reuse each other's provider output.
 */
export function evidenceQueryScope(event: EventRecord, queries: string[] | undefined): string {
  const binding = createHash("sha256")
    .update(
      JSON.stringify([
        event.polymarketMarketId ?? null,
        [...event.entities].sort(),
        [...event.marketSymbols].sort(),
        [...(queries ?? [])].sort(),
      ]),
    )
    .digest("hex")
    .slice(0, 16);

  return `${event.question} ${binding}`;
}

function summarizeProviderRuns(providerRuns: ProviderRun[]): string {
  return providerRuns
    .map((run) => {
      const parts = [
        `raw=${run.rawCount}`,
        `normalized=${run.normalizedCount}`,
        `cache=${run.cacheStatus}`,
      ];

      if (run.error) {
        parts.push(`error=${run.error}`);
      }

      return `${run.providerName} (${parts.join(", ")})`;
    })
    .join("; ");
}

export async function collectEvidenceForEventWithCache(
  args: CollectEvidenceArgs & {
    cacheStore: EvidenceCacheStore;
    logger?: AppLogger;
    ttlSeconds?: number;
  },
): Promise<CollectEvidenceResult> {
  const logger = args.logger?.child({
    component: "evidence",
  });
  const collectFromProvider = async (
    provider: CollectEvidenceArgs["providers"][number],
  ): Promise<{ items: EvidenceItem[]; run: ProviderRun }> => {
    const completed = (items: EvidenceItem[], cacheStatus: ProviderRun["cacheStatus"]) => ({
      items,
      run: {
        providerName: provider.name,
        rawCount: items.length,
        normalizedCount: normalizeEvidenceItems(items).length,
        cacheStatus,
      },
    });
    const collect = () =>
      provider.collect({
        event: args.event,
        evaluationTime: args.evaluationTime,
        mode: args.mode,
        queries: args.queries,
      });

    try {
      if (args.mode === "fixture") {
        return completed(await collect(), "bypass");
      }

      const cacheKey = buildEvidenceCacheKey(
        evidenceQueryScope(args.event, args.queries),
        args.evaluationTime,
        provider.name,
      );
      const cached = await args.cacheStore.get(cacheKey);

      if (cached) {
        return completed(
          (JSON.parse(cached) as EvidenceItem[]).map((item) => ({ ...item, eventId: args.event.id })),
          "hit",
        );
      }

      const providerItems = await collect();

      await args.cacheStore.set(
        cacheKey,
        JSON.stringify(providerItems),
        args.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      );

      return completed(providerItems, "miss");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error(
        {
          event: "evidence_provider_failed",
          err: error,
          providerName: provider.name,
        },
        `evidence provider "${provider.name}" failed: ${errorMessage}`,
      );
      return {
        items: [],
        run: {
          providerName: provider.name,
          rawCount: 0,
          normalizedCount: 0,
          cacheStatus: "bypass",
          error: errorMessage,
        },
      };
    }
  };

  // Providers are independent network calls, so they run at once: the run takes as long as
  // the slowest source, not the sum of them. Results keep provider order, which decides
  // whose copy of a duplicate survives normalisation.
  const collected = await Promise.all(args.providers.map(collectFromProvider));
  const providerRuns = collected.map((outcome) => outcome.run);
  const rawItems = collected.flatMap((outcome) => outcome.items);

  const failedRuns = providerRuns.filter((run) => run.error);
  if (
    args.mode === "live" &&
    args.providers.length > 0 &&
    failedRuns.length === args.providers.length
  ) {
    const summary = failedRuns.map((run) => `${run.providerName}: ${run.error}`).join("; ");
    throw new Error(
      `All ${args.providers.length} evidence provider(s) failed in live mode: ${summary}`,
    );
  }

  const normalizedItems = normalizeEvidenceItems(rawItems);

  if (args.mode === "live" && args.providers.length > 0 && normalizedItems.length === 0) {
    throw new Error(
      `All ${args.providers.length} live evidence provider(s) returned zero evidence items: ${summarizeProviderRuns(providerRuns)}`,
    );
  }

  const items = await insertEvidenceItems(args.pool, normalizedItems);

  logger?.info(
    {
      event: "evidence_collection_completed",
      normalizedCount: normalizedItems.length,
      persistedCount: items.length,
      providerRuns,
      rawCount: rawItems.length,
      failedProviders: failedRuns.map((run) => run.providerName),
    },
    "evidence collection completed",
  );

  return {
    items,
    normalizedItems,
    providerRuns,
  };
}
