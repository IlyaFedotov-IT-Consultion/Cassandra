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
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
