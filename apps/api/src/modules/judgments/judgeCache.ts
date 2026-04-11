import { createHash } from "node:crypto";

import type { Redis } from "ioredis";

import type { AdapterMode } from "../evidence/types.js";

const DEFAULT_TTL_SECONDS = 60 * 60 * 12;

export interface JudgeCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface JudgeCacheKeyParts {
  judgeName: string;
  evidenceIds: string[];
  judgeModelVersion: string;
  promptVersion: string;
  snapshotId: string;
}

export class InMemoryJudgeCacheStore implements JudgeCacheStore {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

export function createRedisJudgeCacheStore(redis: Redis): JudgeCacheStore {
  return {
    async get(key: string) {
      return redis.get(key);
    },
    async set(key: string, value: string, ttlSeconds: number) {
      await redis.set(key, value, "EX", ttlSeconds);
    },
  };
}

export function buildJudgeCacheKey(parts: JudgeCacheKeyParts): string {
  const evidenceDigest = createHash("sha256")
    .update(parts.evidenceIds.slice().sort().join("|"))
    .digest("hex");

  return [
    "judge",
    parts.judgeName,
    parts.judgeModelVersion,
    parts.promptVersion,
    parts.snapshotId,
    evidenceDigest,
  ].join(":");
}

export async function getOrCreateCachedJudgeResult<T>(args: {
  cacheStore: JudgeCacheStore;
  mode: AdapterMode;
  cacheKeyParts: JudgeCacheKeyParts;
  ttlSeconds?: number;
  load: () => Promise<T>;
}): Promise<T> {
  if (args.mode === "fixture") {
    return args.load();
  }

  const cacheKey = buildJudgeCacheKey(args.cacheKeyParts);
  const cached = await args.cacheStore.get(cacheKey);

  if (cached) {
    return JSON.parse(cached) as T;
  }

  const value = await args.load();

  await args.cacheStore.set(
    cacheKey,
    JSON.stringify(value),
    args.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  );

  return value;
}
