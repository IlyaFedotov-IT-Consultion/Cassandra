import { describe, expect, it } from "vitest";

import {
  InMemoryJudgeCacheStore,
  buildJudgeCacheKey,
  getOrCreateCachedJudgeResult,
} from "../src/modules/judgments/judgeCache.js";

describe("judge cache", () => {
  it("reuses cached judge results in live mode and reports cache status", async () => {
    const cacheStore = new InMemoryJudgeCacheStore();
    let calls = 0;

    const first = await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "live",
      cacheKeyParts: {
        judgeName: "panel",
        evidenceIds: ["evidence-1", "evidence-2"],
        judgeModelVersion: "judge-v1",
        promptVersion: "prompt-v1",
        snapshotId: "snapshot-1",
      },
      load: async () => {
        calls += 1;

        return {
          finalProbability: 0.63,
        };
      },
    });

    const second = await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "live",
      cacheKeyParts: {
        judgeName: "panel",
        evidenceIds: ["evidence-2", "evidence-1"],
        judgeModelVersion: "judge-v1",
        promptVersion: "prompt-v1",
        snapshotId: "snapshot-1",
      },
      load: async () => {
        calls += 1;

        return {
          finalProbability: 0.11,
        };
      },
    });

    expect(calls).toBe(1);
    expect(first.cacheStatus).toBe("miss");
    expect(second.cacheStatus).toBe("hit");
    expect(second.value).toEqual(first.value);
  });

  it("bypasses the cache in fixture mode", async () => {
    const cacheStore = new InMemoryJudgeCacheStore();
    let calls = 0;

    const first = await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "fixture",
      cacheKeyParts: {
        judgeName: "panel",
        evidenceIds: ["evidence-1"],
        judgeModelVersion: "judge-v1",
        promptVersion: "prompt-v1",
        snapshotId: "snapshot-1",
      },
      load: async () => {
        calls += 1;

        return {
          finalProbability: 0.25,
        };
      },
    });

    const second = await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "fixture",
      cacheKeyParts: {
        judgeName: "panel",
        evidenceIds: ["evidence-1"],
        judgeModelVersion: "judge-v1",
        promptVersion: "prompt-v1",
        snapshotId: "snapshot-1",
      },
      load: async () => {
        calls += 1;

        return {
          finalProbability: 0.75,
        };
      },
    });

    expect(calls).toBe(2);
    expect(first.cacheStatus).toBe("bypass");
    expect(second.cacheStatus).toBe("bypass");
  });

  it("changes the cache key when the calibration snapshot changes", () => {
    const first = buildJudgeCacheKey({
      judgeName: "panel",
      evidenceIds: ["evidence-1"],
      judgeModelVersion: "judge-v1",
      promptVersion: "prompt-v1",
      snapshotId: "snapshot-1",
    });

    const second = buildJudgeCacheKey({
      judgeName: "panel",
      evidenceIds: ["evidence-1"],
      judgeModelVersion: "judge-v1",
      promptVersion: "prompt-v1",
      snapshotId: "snapshot-2",
    });

    expect(first).not.toBe(second);
  });
});
