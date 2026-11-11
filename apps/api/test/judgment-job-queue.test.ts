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

  it("retries a transient failure and eventually completes the job", async () => {
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
          throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { code: "ECONNREFUSED" });
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

  async function runUntilFailed(args: {
    attempts?: number;
    fail: () => Error;
  }): Promise<{ attempts: number; failedReason: string | undefined }> {
    const queueName = `judgment-queue-test-${randomUUID()}`;
    const queue = createBullMqJudgmentQueue({
      connection: redis,
      queueName,
      defaultJobOptions: {
        ...(args.attempts === undefined ? {} : { attempts: args.attempts }),
        backoff: { type: "fixed", delay: 1 },
        removeOnFail: true,
      },
    });
    let attempts = 0;
    const worker = createBullMqJudgmentWorker({
      connection: redis,
      queueName,
      processJob: async () => {
        attempts += 1;
        throw args.fail();
      },
    });
    const finalFailure = new Promise<string | undefined>((resolve) => {
      worker.on("failed", (job, error) => {
        if (!job || job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === "UnrecoverableError") {
          resolve(job?.failedReason);
        }
      });
    });

    try {
      await queue.enqueue({
        judgmentId: randomUUID(),
        eventId: randomUUID(),
        evaluationTime: "2026-10-11T12:00:00Z",
      });
      const failedReason = await finalFailure;
      // Give a wrongly scheduled retry time to run before counting attempts.
      await new Promise((resolve) => setTimeout(resolve, 150));

      return { attempts, failedReason };
    } finally {
      await worker.close();
      await queue.close();
    }
  }

  it("does not pay for a second attempt at a failure that would repeat", async () => {
    const outcome = await runUntilFailed({
      attempts: 3,
      fail: () => new Error("Judge trace eventId mismatch: expected a, got b"),
    });

    expect(outcome.attempts).toBe(1);
    expect(outcome.failedReason).toContain("eventId mismatch");
  });

  it("makes at most two attempts by default, even when the failure looks transient", async () => {
    const outcome = await runUntilFailed({
      fail: () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { code: "ECONNREFUSED" }),
    });

    expect(outcome.attempts).toBe(2);
  });
});
