import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";

import { closeRedisConnection, createRedisConnection } from "../src/lib/queue.js";
import {
  cadenceToIntervalMs,
  createBullMqWatchlistDiscoveryScheduler,
  createBullMqWatchlistDiscoveryWorker,
} from "../src/modules/watchlists/schedule.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DAY_MS = 86_400_000;

describe("cadenceToIntervalMs", () => {
  it("maps the supported cadences and leaves anything else unscheduled", () => {
    expect(cadenceToIntervalMs("hourly")).toBe(3_600_000);
    expect(cadenceToIntervalMs(" Daily ")).toBe(DAY_MS);
    expect(cadenceToIntervalMs("weekly")).toBe(7 * DAY_MS);
    expect(cadenceToIntervalMs("manual")).toBeNull();
    expect(cadenceToIntervalMs("fortnightly")).toBeNull();
  });
});

describe("watchlist discovery scheduler", () => {
  const redis = createRedisConnection(REDIS_URL);
  const queueNames: string[] = [];
  const newQueueName = () => {
    const name = `watchlist-discovery-test-${randomUUID()}`;
    queueNames.push(name);
    return name;
  };

  afterAll(async () => {
    for (const name of queueNames) {
      const queue = new Queue(name, { connection: redis });
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await closeRedisConnection(redis);
  });

  it("schedules the first run one interval out and keeps it when synced again", async () => {
    const scheduler = createBullMqWatchlistDiscoveryScheduler({ connection: redis, queueName: newQueueName() });

    try {
      const before = Date.now();
      await scheduler.sync({ id: "watchlist-1", cadence: "daily" });
      const first = await scheduler.describe({ id: "watchlist-1", cadence: "daily" });

      expect(first.intervalMs).toBe(DAY_MS);
      // Creating a watchlist must not start (possibly paid) discovery straight away.
      expect(Date.parse(first.nextRunAt!)).toBeGreaterThanOrEqual(before + DAY_MS - 1_000);

      // An API restart syncs every watchlist again; that must not move the next run.
      await scheduler.sync({ id: "watchlist-1", cadence: "daily" });
      expect((await scheduler.describe({ id: "watchlist-1", cadence: "daily" })).nextRunAt).toBe(first.nextRunAt);

      await scheduler.sync({ id: "watchlist-1", cadence: "manual" });
      expect(await scheduler.describe({ id: "watchlist-1", cadence: "manual" })).toEqual({
        cadence: "manual",
        intervalMs: null,
        nextRunAt: null,
      });
    } finally {
      await scheduler.close();
    }
  });

  it("delivers each scheduled run to the worker with its watchlist id", async () => {
    const queueName = newQueueName();
    const scheduler = createBullMqWatchlistDiscoveryScheduler({
      connection: redis,
      queueName,
      intervalForCadence: (cadence) => (cadence === "test" ? 300 : null),
    });
    let resolveRun: (watchlistId: string) => void = () => {};
    const ran = new Promise<string>((resolve) => {
      resolveRun = resolve;
    });
    const worker = createBullMqWatchlistDiscoveryWorker({
      connection: redis,
      queueName,
      processJob: async (watchlistId) => resolveRun(watchlistId),
    });

    try {
      await scheduler.sync({ id: "watchlist-2", cadence: "test" });
      const watchlistId = await Promise.race([
        ran,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("no scheduled run within 5s")), 5_000)),
      ]);

      expect(watchlistId).toBe("watchlist-2");
    } finally {
      await worker.close();
      await scheduler.close();
    }
  });
});
