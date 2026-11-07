import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

import type { WatchlistSchedule } from "@cassandra/shared";

export const WATCHLIST_DISCOVERY_QUEUE_NAME = "watchlist-discovery";
const DISCOVERY_JOB_NAME = "discover-watchlist";

const HOUR_MS = 3_600_000;
const INTERVAL_BY_CADENCE: Record<string, number> = {
  hourly: HOUR_MS,
  daily: 24 * HOUR_MS,
  weekly: 7 * 24 * HOUR_MS,
};

/** The schedule interval for a cadence, or null when the cadence means "only when started" (e.g. "manual"). */
export function cadenceToIntervalMs(cadence: string): number | null {
  return INTERVAL_BY_CADENCE[cadence.trim().toLowerCase()] ?? null;
}

type ScheduledWatchlist = { id: string; cadence: string };

export interface WatchlistDiscoveryScheduler {
  /** Creates, updates or removes the watchlist's schedule to match its cadence. Safe to call repeatedly. */
  sync(watchlist: ScheduledWatchlist): Promise<void>;
  describe(watchlist: ScheduledWatchlist): Promise<WatchlistSchedule>;
  remove(watchlistId: string): Promise<void>;
  close(): Promise<void>;
}

interface DiscoveryJobData {
  watchlistId: string;
}

const schedulerId = (watchlistId: string) => `watchlist:${watchlistId}`;

export function createBullMqWatchlistDiscoveryScheduler(args: {
  connection: Redis;
  queueName?: string;
  /** Overrides the cadence-to-interval mapping (tests use sub-second intervals). */
  intervalForCadence?: (cadence: string) => number | null;
}): WatchlistDiscoveryScheduler {
  const queue = new Queue<DiscoveryJobData>(args.queueName ?? WATCHLIST_DISCOVERY_QUEUE_NAME, {
    connection: args.connection,
  });
  const intervalFor = args.intervalForCadence ?? cadenceToIntervalMs;

  return {
    async sync(watchlist) {
      const every = intervalFor(watchlist.cadence);

      if (every === null) {
        await queue.removeJobScheduler(schedulerId(watchlist.id));
        return;
      }

      // With an unchanged interval BullMQ keeps the existing next run, so re-syncing on every API start does not
      // trigger extra runs. startDate only applies to a new (or re-timed) schedule: its first run is one interval
      // out, so creating a watchlist never starts discovery (and, in live mode, paid search) on the spot.
      await queue.upsertJobScheduler(
        schedulerId(watchlist.id),
        { every, startDate: Date.now() + every },
        {
          name: DISCOVERY_JOB_NAME,
          data: { watchlistId: watchlist.id },
          opts: {
            attempts: 2,
            backoff: { type: "exponential", delay: 30_000 },
            removeOnComplete: 50,
            removeOnFail: 50,
          },
        },
      );
    },
    async describe(watchlist) {
      const intervalMs = intervalFor(watchlist.cadence);
      const scheduler = intervalMs === null ? undefined : await queue.getJobScheduler(schedulerId(watchlist.id));

      return {
        cadence: watchlist.cadence,
        intervalMs,
        nextRunAt: typeof scheduler?.next === "number" ? new Date(scheduler.next).toISOString() : null,
      };
    },
    async remove(watchlistId) {
      await queue.removeJobScheduler(schedulerId(watchlistId));
    },
    async close() {
      await queue.close();
    },
  };
}

export function createBullMqWatchlistDiscoveryWorker(args: {
  connection: Redis;
  processJob: (watchlistId: string) => Promise<unknown>;
  queueName?: string;
}) {
  return new Worker<DiscoveryJobData>(
    args.queueName ?? WATCHLIST_DISCOVERY_QUEUE_NAME,
    async (job) => {
      await args.processJob(job.data.watchlistId);
    },
    {
      // Discovery calls external search providers; one run at a time keeps rate limits and cost predictable.
      concurrency: 1,
      connection: args.connection.duplicate(),
    },
  );
}
