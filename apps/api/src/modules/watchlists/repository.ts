import { randomUUID } from "node:crypto";

import type { WatchlistInput } from "@cassandra/shared";
import type { Pool } from "pg";

export async function createWatchlist(pool: Pool, input: WatchlistInput) {
  const result = await pool.query(
    `
      INSERT INTO watchlists (
        id,
        name,
        keywords,
        jurisdictions,
        cadence,
        source_toggles
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb)
      RETURNING *
    `,
    [
      randomUUID(),
      input.name,
      JSON.stringify(input.keywords),
      JSON.stringify(input.jurisdictions),
      input.cadence,
      JSON.stringify(input.sourceToggles),
    ],
  );

  return result.rows[0];
}
