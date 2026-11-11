import { Queue, UnrecoverableError, Worker, type JobsOptions, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";

import { JudgeServiceError } from "./errors.js";
import type { RunJudgmentInput } from "./service.js";

export const JUDGMENT_QUEUE_NAME = "judgment-queue";
const DEFAULT_JOB_NAME = "run-judgment";

const TRANSIENT_JUDGE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]);

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Whether a failed judgment run is worth a second, paid attempt. Only failures that a
 * retry can plausibly fix count: an overloaded or unreachable service, a timeout, or
 * every evidence provider being down. Anything else would fail the same way again.
 */
export function isTransientJudgmentFailure(error: unknown): boolean {
  if (error instanceof JudgeServiceError) {
    return TRANSIENT_JUDGE_STATUSES.has(error.status);
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }

  const code = errorCode(error) ?? errorCode(error.cause);

  if (code && TRANSIENT_NETWORK_CODES.has(code)) {
    return true;
  }

  return /^All \d+ evidence provider\(s\) failed/.test(error.message);
}

export interface JudgmentJobQueue {
  enqueue(input: RunJudgmentInput): Promise<void>;
  close(): Promise<void>;
}

export function createBullMqJudgmentQueue(args: {
  connection: Redis;
  queueName?: string;
  defaultJobOptions?: JobsOptions;
}): JudgmentJobQueue {
  const queue = new Queue<RunJudgmentInput>(args.queueName ?? JUDGMENT_QUEUE_NAME, {
    connection: args.connection,
    defaultJobOptions: {
      // One retry at most: every attempt of a live judgment pays for search and model calls.
      attempts: 2,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: 100,
      removeOnFail: 100,
      ...args.defaultJobOptions,
    },
  });

  return {
    async enqueue(input) {
      await queue.add(DEFAULT_JOB_NAME, input);
    },
    async close() {
      await queue.close();
    },
  };
}

export function createBullMqJudgmentWorker(args: {
  connection: Redis;
  processJob: (input: RunJudgmentInput) => Promise<unknown>;
  queueName?: string;
  workerOptions?: Omit<WorkerOptions, "connection">;
}) {
  const workerConnection = args.connection.duplicate();

  return new Worker<RunJudgmentInput>(
    args.queueName ?? JUDGMENT_QUEUE_NAME,
    async (job) => {
      try {
        await args.processJob(job.data);
      } catch (error) {
        if (isTransientJudgmentFailure(error)) {
          throw error;
        }

        // BullMQ fails the job at once instead of scheduling another attempt.
        throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
      }
    },
    {
      concurrency: 1,
      ...args.workerOptions,
      connection: workerConnection,
    },
  );
}
