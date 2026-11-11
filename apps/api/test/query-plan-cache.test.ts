import { describe, expect, it } from "vitest";

import { getEnv } from "../src/config/env.js";
import { InMemoryEvidenceCacheStore } from "../src/modules/evidence/cache.js";
import type { EventRecord } from "../src/modules/events/repository.js";
import { planEventQueries, type JudgeClient } from "../src/modules/judgments/service.js";

const event: EventRecord = {
  id: "event-plan",
  question: "Will Example Corp launch Product X by 2026-12-31?",
  resolutionCriteria: "Official launch announcement.",
  deadline: "2026-12-31T23:59:59Z",
  status: "active",
  entities: ["Example Corp"],
  referenceClass: null,
  marketSymbols: [],
  polymarketMarketId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function countingPlanner() {
  let calls = 0;
  const client: JudgeClient = {
    async judge() {
      throw new Error("not used");
    },
    async plan() {
      calls += 1;
      return { subQuestions: ["Has a date been announced?"], queries: [`launch date query ${calls}`], model: "utility" };
    },
  };
  return { client, calls: () => calls };
}

const liveEnv = getEnv({ CASSANDRA_ADAPTER_MODE: "live" });

describe("query plan cache", () => {
  it("plans once for a retried judgment and reuses the same queries", async () => {
    const planner = countingPlanner();
    const cacheStore = new InMemoryEvidenceCacheStore();
    const args = { env: liveEnv, event, evaluationTime: "2026-10-11T12:05:00Z", judgeClient: planner.client, cacheStore };

    const first = await planEventQueries(args);
    const retry = await planEventQueries(args);

    expect(planner.calls()).toBe(1);
    expect(retry.queries).toEqual(first.queries);
    expect(first.stage.details.cacheStatus).toBe("miss");
    expect(retry.stage.details.cacheStatus).toBe("hit");
  });

  it("plans again for a later evaluation time", async () => {
    const planner = countingPlanner();
    const cacheStore = new InMemoryEvidenceCacheStore();

    await planEventQueries({ env: liveEnv, event, evaluationTime: "2026-10-11T12:05:00Z", judgeClient: planner.client, cacheStore });
    await planEventQueries({ env: liveEnv, event, evaluationTime: "2026-10-11T15:05:00Z", judgeClient: planner.client, cacheStore });

    expect(planner.calls()).toBe(2);
  });

  it("does not cache a failed plan", async () => {
    let calls = 0;
    const client: JudgeClient = {
      async judge() {
        throw new Error("not used");
      },
      async plan() {
        calls += 1;
        if (calls === 1) {
          throw new Error("planner unavailable");
        }
        return { subQuestions: [], queries: ["second attempt query"], model: null };
      },
    };
    const cacheStore = new InMemoryEvidenceCacheStore();
    const args = { env: liveEnv, event, evaluationTime: "2026-10-11T12:05:00Z", judgeClient: client, cacheStore };

    const failed = await planEventQueries(args);
    const second = await planEventQueries(args);

    expect(failed.stage.status).toBe("failed");
    expect(second.queries).toEqual(["second attempt query"]);
  });

  it("bypasses the cache in fixture mode", async () => {
    const planner = countingPlanner();
    const cacheStore = new InMemoryEvidenceCacheStore();
    const args = {
      env: getEnv({ CASSANDRA_ADAPTER_MODE: "fixture" }),
      event,
      evaluationTime: "2026-10-11T12:05:00Z",
      judgeClient: planner.client,
      cacheStore,
    };

    await planEventQueries(args);
    await planEventQueries(args);

    expect(planner.calls()).toBe(2);
  });
});
