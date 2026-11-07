import { randomUUID } from "node:crypto";

import type { OutcomeInput, OutcomeRecord } from "@cassandra/shared";
import type { Pool } from "pg";

export type { OutcomeRecord };

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapOutcomeRow(row: Record<string, unknown>): OutcomeRecord {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    resolvedValue: Boolean(row.resolved_value),
    resolvedAt: toIsoString(row.resolved_at),
    resolutionSourceUrl: String(row.resolution_source_url),
    createdAt: toIsoString(row.created_at),
  };
}

export async function createOutcome(pool: Pool, input: OutcomeInput): Promise<OutcomeRecord> {
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

  return mapOutcomeRow(result.rows[0] as Record<string, unknown>);
}

// Newest recorded first: a later outcome for the same event is a correction of an earlier one.
export async function listOutcomes(pool: Pool, eventId?: string): Promise<OutcomeRecord[]> {
  const result = eventId
    ? await pool.query(`SELECT * FROM outcomes WHERE event_id = $1 ORDER BY created_at DESC`, [eventId])
    : await pool.query(`SELECT * FROM outcomes ORDER BY created_at DESC`);

  return result.rows.map((row) => mapOutcomeRow(row as Record<string, unknown>));
}

export async function countOutcomes(pool: Pool): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*)::int AS count FROM outcomes`);

  return Number(result.rows[0]?.count ?? 0);
}
