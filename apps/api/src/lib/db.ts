import { Pool } from "pg";

export function createDbPool(connectionString: string) {
  return new Pool({
    connectionString,
  });
}

export async function checkDbReady(pool: Pool) {
  await pool.query("select 1");
}

export async function closeDbPool(pool: Pool) {
  await pool.end();
}
