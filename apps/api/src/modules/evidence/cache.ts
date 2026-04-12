import type { Redis } from "ioredis";

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
    ttlSeconds?: number;
  },
): Promise<CollectEvidenceResult> {
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
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[evidence] provider ${provider.name} failed, skipping: ${message}`);
      providerRuns.push({
        providerName: provider.name,
        rawCount: 0,
        normalizedCount: 0,
        cacheStatus: "bypass",
      });
    }
  }

  const normalizedItems = normalizeEvidenceItems(rawItems);
  const items = await insertEvidenceItems(args.pool, normalizedItems);

  return {
    items,
    normalizedItems,
    providerRuns,
  };
}
