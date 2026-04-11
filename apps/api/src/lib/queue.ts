import { Redis } from "ioredis";

export function createRedisConnection(connectionString: string) {
  return new Redis(connectionString, {
    maxRetriesPerRequest: null,
  });
}

export async function checkRedisReady(connection: Redis) {
  const result = await connection.ping();

  if (result !== "PONG") {
    throw new Error(`Unexpected Redis ping response: ${result}`);
  }
}

export async function closeRedisConnection(connection: Redis) {
  await connection.quit();
}
