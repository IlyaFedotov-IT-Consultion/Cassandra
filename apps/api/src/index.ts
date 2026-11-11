import { buildApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { checkDbReady, closeDbPool, createDbPool } from "./lib/db.js";
import {
  checkRedisReady,
  closeRedisConnection,
  createRedisConnection,
} from "./lib/queue.js";
import {
  createEvidenceCacheStore,
  createJudgeCacheStore,
} from "./modules/judgments/service.js";
import {
  createBullMqJudgmentQueue,
  createBullMqJudgmentWorker,
} from "./modules/judgments/jobQueue.js";
import { createDefaultEvidenceProviders } from "./modules/judgments/service.js";
import { listWatchlists } from "./modules/watchlists/repository.js";
import {
  createBullMqWatchlistDiscoveryScheduler,
  createBullMqWatchlistDiscoveryWorker,
} from "./modules/watchlists/schedule.js";
import { runJudgmentWorker } from "./workers/judgmentWorker.js";
import { runWatchlistDiscoveryWorker } from "./workers/watchlistWorker.js";

const env = getEnv();
const dbPool = createDbPool(env.DATABASE_URL);
const redisConnection = createRedisConnection(env.REDIS_URL);
const judgmentQueue = createBullMqJudgmentQueue({
  connection: redisConnection,
});
const discoveryScheduler =
  env.CASSANDRA_DISCOVERY_SCHEDULE === "on"
    ? createBullMqWatchlistDiscoveryScheduler({ connection: redisConnection })
    : undefined;

const app = buildApp({
  dbPool,
  env,
  redisConnection,
  judgmentQueue,
  watchlistDiscoveryScheduler: discoveryScheduler,
  checkDb: async () => checkDbReady(dbPool),
  checkRedis: async () => checkRedisReady(redisConnection),
});
const evidenceCacheStore = createEvidenceCacheStore(redisConnection);
const judgeCacheStore = createJudgeCacheStore(redisConnection);
const judgmentWorker = createBullMqJudgmentWorker({
  connection: redisConnection,
  processJob: async (input) =>
    runJudgmentWorker({
      pool: dbPool,
      env,
      evidenceCacheStore,
      judgeCacheStore,
      logger: app.log.child({
        area: "judgments",
        eventId: input.eventId,
        judgmentId: input.judgmentId,
      }),
      input,
    }),
});

const discoveryLogger = app.log.child({ area: "watchlists" });
const discoveryWorker = discoveryScheduler
  ? createBullMqWatchlistDiscoveryWorker({
      connection: redisConnection,
      processJob: async (watchlistId) => {
        const outcome = await runWatchlistDiscoveryWorker({
          pool: dbPool,
          watchlistId,
          providers: createDefaultEvidenceProviders(env),
          evaluationTime: new Date().toISOString(),
          mode: env.CASSANDRA_ADAPTER_MODE,
        });

        if (!outcome) {
          await discoveryScheduler.remove(watchlistId);
          discoveryLogger.info(
            { event: "watchlist_schedule_removed", watchlistId },
            "schedule removed for a deleted watchlist",
          );
          return;
        }

        discoveryLogger.info(
          {
            event: "watchlist_discovery_completed",
            watchlistId,
            trigger: "scheduled",
            candidateCount: outcome.candidates.length,
            failedProviderCount: outcome.failedProviders.length,
          },
          "scheduled watchlist discovery completed",
        );
      },
    })
  : undefined;

app.addHook("onClose", async () => {
  await Promise.all([
    judgmentWorker.close(),
    judgmentQueue.close(),
    discoveryWorker?.close(),
    discoveryScheduler?.close(),
    closeDbPool(dbPool),
    closeRedisConnection(redisConnection),
  ]);
});

try {
  await app.listen({
    host: env.API_HOST,
    port: env.API_PORT,
  });
  app.log.info(
    {
      event: "server_started",
      adapterMode: env.CASSANDRA_ADAPTER_MODE,
      host: env.API_HOST,
      port: env.API_PORT,
    },
    "server started",
  );
} catch (error) {
  app.log.error(
    {
      event: "server_start_failed",
      err: error,
    },
    "server start failed",
  );
  process.exit(1);
}

// Bring every watchlist's schedule in line with its cadence. Re-syncing an unchanged schedule keeps its next run,
// so restarts do not trigger extra discovery.
if (discoveryScheduler) {
  try {
    const watchlists = await listWatchlists(dbPool);

    for (const watchlist of watchlists) {
      await discoveryScheduler.sync(watchlist);
    }

    discoveryLogger.info(
      { event: "watchlist_schedules_synced", watchlistCount: watchlists.length },
      "watchlist schedules synced",
    );
  } catch (error) {
    discoveryLogger.warn({ event: "watchlist_schedule_sync_failed", err: error }, "watchlist schedule sync failed");
  }
}
