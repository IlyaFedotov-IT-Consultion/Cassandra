import { randomUUID } from "node:crypto";

import type { OutcomeInput } from "@cassandra/shared";
import type { Pool } from "pg";

export async function createOutcome(pool: Pool, input: OutcomeInput) {
  const result = await pool.query(
    `
      INSERT INTO outcomes (
        id,
        event_id,
        resolved_value,
        resolved_at,
        resolution_source_url
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
    [randomUUID(), input.eventId, input.resolvedValue, input.resolvedAt, input.resolutionSourceUrl],
  );

  return result.rows[0];
}
