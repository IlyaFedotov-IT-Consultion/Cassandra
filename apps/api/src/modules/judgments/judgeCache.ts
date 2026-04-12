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
  eventId: string;
  eventQuestion: string;
  evaluationTime: string;
  evidenceFingerprint: string;
  judgeModelVersion: string;
  promptVersion: string;
  snapshotId: string;
}

export type JudgeCacheStatus = "hit" | "miss" | "bypass";

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
  const eventDigest = createHash("sha256")
    .update(
      [
        parts.eventId,
        parts.eventQuestion.trim().toLowerCase(),
        parts.evaluationTime,
        parts.evidenceFingerprint,
      ].join("|"),
    )
    .digest("hex");

  return [
    "judge",
    parts.judgeName,
    parts.judgeModelVersion,
    parts.promptVersion,
    parts.snapshotId,
    eventDigest,
  ].join(":");
}

export async function getOrCreateCachedJudgeResult<T>(args: {
  cacheStore: JudgeCacheStore;
  mode: AdapterMode;
  cacheKeyParts: JudgeCacheKeyParts;
  ttlSeconds?: number;
  load: () => Promise<T>;
}): Promise<{
  cacheKey: string;
  cacheStatus: JudgeCacheStatus;
  value: T;
}> {
  const cacheKey = buildJudgeCacheKey(args.cacheKeyParts);

  if (args.mode === "fixture") {
    return {
      cacheKey,
      cacheStatus: "bypass",
      value: await args.load(),
    };
  }

  const cached = await args.cacheStore.get(cacheKey);

  if (cached) {
    return {
      cacheKey,
      cacheStatus: "hit",
      value: JSON.parse(cached) as T,
    };
  }

  const value = await args.load();

  await args.cacheStore.set(
    cacheKey,
    JSON.stringify(value),
    args.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  );

  return {
    cacheKey,
    cacheStatus: "miss",
    value,
  };
}
