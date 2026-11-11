import { Queue, Worker, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

export const EVALUATION_QUEUE_NAME = "evaluation-queue";
const DEFAULT_JOB_NAME = "run-evaluation";

export interface EvaluationJob {
  runId: string;
}

export interface EvaluationJobQueue {
  enqueue(job: EvaluationJob): Promise<void>;
  close(): Promise<void>;
}

export function createBullMqEvaluationQueue(args: {
  connection: Redis;
  queueName?: string;
  defaultJobOptions?: JobsOptions;
}): EvaluationJobQueue {
  const queue = new Queue<EvaluationJob>(args.queueName ?? EVALUATION_QUEUE_NAME, {
    connection: args.connection,
    defaultJobOptions: {
      // A run is hours of paid model calls, so it is never retried blindly. A run that is
      // picked up again (after a restart) resumes from the forecasts it already stored.
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
      ...args.defaultJobOptions,
    },
  });

  return {
    async enqueue(job) {
      await queue.add(DEFAULT_JOB_NAME, job);
    },
    async close() {
      await queue.close();
    },
  };
}

export function createBullMqEvaluationWorker(args: {
  connection: Redis;
  processJob: (job: EvaluationJob) => Promise<unknown>;
  queueName?: string;
}) {
  return new Worker<EvaluationJob>(
    args.queueName ?? EVALUATION_QUEUE_NAME,
    async (job) => {
      await args.processJob(job.data);
    },
    {
      // One run at a time: each run already issues its own stream of model and search calls.
      concurrency: 1,
      connection: args.connection,
    },
  );
}
