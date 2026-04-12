import { buildApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { checkDbReady, closeDbPool, createDbPool } from "./lib/db.js";
import {
  checkRedisReady,
  closeRedisConnection,
  createRedisConnection,
} from "./lib/queue.js";

const env = getEnv();
const dbPool = createDbPool(env.DATABASE_URL);
const redisConnection = createRedisConnection(env.REDIS_URL);

const app = buildApp({
  dbPool,
  env,
  redisConnection,
  checkDb: async () => checkDbReady(dbPool),
  checkRedis: async () => checkRedisReady(redisConnection),
});

app.addHook("onClose", async () => {
  await Promise.all([
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
