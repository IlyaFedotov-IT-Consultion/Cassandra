import type { Redis } from "ioredis";

import type { AppLogger } from "../../lib/logger.js";
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
  const providerRuns: ProviderRun[] = [];
  const rawItems = [];

  for (const provider of args.providers) {
    try {
      if (args.mode === "fixture") {
        const providerItems = await provider.collect({
          event: args.event,
          evaluationTime: args.evaluationTime,
          mode: args.mode,
        });

        rawItems.push(...providerItems);
        providerRuns.push({
          providerName: provider.name,
          rawCount: providerItems.length,
          normalizedCount: normalizeEvidenceItems(providerItems).length,
          cacheStatus: "bypass",
        });
        continue;
      }

      const cacheKey = buildEvidenceCacheKey(args.event.question, args.evaluationTime, provider.name);
      const cached = await args.cacheStore.get(cacheKey);

      if (cached) {
        const providerItems = JSON.parse(cached);
        rawItems.push(...providerItems);
        providerRuns.push({
          providerName: provider.name,
          rawCount: providerItems.length,
          normalizedCount: normalizeEvidenceItems(providerItems).length,
          cacheStatus: "hit",
        });
        continue;
      }

      const providerItems = await provider.collect({
        event: args.event,
        evaluationTime: args.evaluationTime,
        mode: args.mode,
      });

      await args.cacheStore.set(
        cacheKey,
        JSON.stringify(providerItems),
        args.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      );

      rawItems.push(...providerItems);
      providerRuns.push({
        providerName: provider.name,
        rawCount: providerItems.length,
        normalizedCount: normalizeEvidenceItems(providerItems).length,
        cacheStatus: "miss",
      });
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
      providerRuns.push({
        providerName: provider.name,
        rawCount: 0,
        normalizedCount: 0,
        cacheStatus: "bypass",
        error: errorMessage,
      });
    }
  }

  const failedRuns = providerRuns.filter((run) => run.error);
  if (
    args.mode === "live" &&
    args.providers.length > 0 &&
    failedRuns.length === args.providers.length
  ) {
    const summary = failedRuns
      .map((run) => `${run.providerName}: ${run.error}`)
      .join("; ");
    throw new Error(
      `All ${args.providers.length} evidence provider(s) failed in live mode: ${summary}`,
    );
  }

  const normalizedItems = normalizeEvidenceItems(rawItems);
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
