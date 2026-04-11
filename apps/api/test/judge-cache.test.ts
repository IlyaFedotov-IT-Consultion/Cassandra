import { describe, expect, it } from "vitest";

import {
  InMemoryJudgeCacheStore,
  getOrCreateCachedJudgeResult,
} from "../src/modules/judgments/judgeCache.js";

describe("judge cache", () => {
  it("reuses cached judge results in live mode", async () => {
    const cacheStore = new InMemoryJudgeCacheStore();
    let calls = 0;

    const first = await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "live",
      cacheKeyParts: {
        judgeName: "panel",
        eventId: "event-1",
        evaluationTime: "2026-10-11T12:00:00Z",
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
        eventId: "event-1",
        evaluationTime: "2026-10-11T12:00:00Z",
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
    expect(second).toEqual(first);
  });

  it("bypasses the cache in fixture mode", async () => {
    const cacheStore = new InMemoryJudgeCacheStore();
    let calls = 0;

    await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "fixture",
      cacheKeyParts: {
        judgeName: "panel",
        eventId: "event-1",
        evaluationTime: "2026-10-11T12:00:00Z",
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

    await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "fixture",
      cacheKeyParts: {
        judgeName: "panel",
        eventId: "event-1",
        evaluationTime: "2026-10-11T12:00:00Z",
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
  });

  it("does not reuse cached results across different replay cutoffs", async () => {
    const cacheStore = new InMemoryJudgeCacheStore();
    let calls = 0;

    const first = await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "live",
      cacheKeyParts: {
        judgeName: "panel",
        eventId: "event-1",
        evaluationTime: "2026-12-01T12:00:00Z",
        evidenceIds: ["evidence-1"],
        judgeModelVersion: "judge-v1",
        promptVersion: "prompt-v1",
        snapshotId: "snapshot-1",
      },
      load: async () => {
        calls += 1;

        return {
          finalProbability: 0.41,
        };
      },
    });

    const second = await getOrCreateCachedJudgeResult({
      cacheStore,
      mode: "live",
      cacheKeyParts: {
        judgeName: "panel",
        eventId: "event-1",
        evaluationTime: "2026-12-24T12:00:00Z",
        evidenceIds: ["evidence-1"],
        judgeModelVersion: "judge-v1",
        promptVersion: "prompt-v1",
        snapshotId: "snapshot-1",
      },
      load: async () => {
        calls += 1;

        return {
          finalProbability: 0.61,
        };
      },
    });

    expect(calls).toBe(2);
    expect(first).not.toEqual(second);
  });
});
