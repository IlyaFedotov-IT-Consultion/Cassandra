import { Queue, Worker, type JobsOptions, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";

import type { RunJudgmentInput } from "./service.js";

export const JUDGMENT_QUEUE_NAME = "judgment-queue";
const DEFAULT_JOB_NAME = "run-judgment";

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
      attempts: 3,
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
      await args.processJob(job.data);
    },
    {
      concurrency: 1,
      ...args.workerOptions,
      connection: workerConnection,
    },
  );
}
