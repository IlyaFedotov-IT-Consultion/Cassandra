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
import { runJudgmentWorker } from "./workers/judgmentWorker.js";

const env = getEnv();
const dbPool = createDbPool(env.DATABASE_URL);
const redisConnection = createRedisConnection(env.REDIS_URL);
const judgmentQueue = createBullMqJudgmentQueue({
  connection: redisConnection,
});

const app = buildApp({
  dbPool,
  env,
  redisConnection,
  judgmentQueue,
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

app.addHook("onClose", async () => {
  await Promise.all([
    judgmentWorker.close(),
    judgmentQueue.close(),
    closeDbPool(dbPool),
    closeRedisConnection(redisConnection),
  ]);
});

try {
  await app.listen({
    host: "0.0.0.0",
    port: env.API_PORT,
  });
  app.log.info(
    {
      event: "server_started",
      adapterMode: env.CASSANDRA_ADAPTER_MODE,
      host: "0.0.0.0",
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
