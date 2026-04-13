import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeRedisConnection,
  createRedisConnection,
} from "../src/lib/queue.js";
import {
  createBullMqJudgmentQueue,
  createBullMqJudgmentWorker,
} from "../src/modules/judgments/jobQueue.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

describe("judgment job queue", () => {
  const redis = createRedisConnection(REDIS_URL);

  beforeAll(async () => {
    await redis.ping();
  });

  afterAll(async () => {
    await closeRedisConnection(redis);
  });

  it("retries failed jobs and eventually completes them", async () => {
    const queueName = `judgment-queue-test-${randomUUID()}`;
    const queue = createBullMqJudgmentQueue({
      connection: redis,
      queueName,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: "fixed",
          delay: 1,
        },
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
    let attempts = 0;
    let resolveProcessed: ((value: unknown) => void) | undefined;
    const processed = new Promise((resolve) => {
      resolveProcessed = resolve;
    });
    const worker = createBullMqJudgmentWorker({
      connection: redis,
      queueName,
      processJob: async (input) => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("retry me");
        }

        resolveProcessed?.(input);
      },
    });

    try {
      const input = {
        judgmentId: randomUUID(),
        eventId: randomUUID(),
        evaluationTime: "2026-10-11T12:00:00Z",
      };

      await queue.enqueue(input);
      await processed;

      expect(attempts).toBe(2);
    } finally {
      await worker.close();
      await queue.close();
    }
  });
});
