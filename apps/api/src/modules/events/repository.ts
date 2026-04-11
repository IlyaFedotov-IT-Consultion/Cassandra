import { randomUUID } from "node:crypto";

import { ReferenceClassSchema, type EventInput } from "@cassandra/shared";
import type { Pool } from "pg";

export interface EventRecord {
  id: string;
  question: string;
  resolutionCriteria: string;
  deadline: string;
  status: string;
  entities: string[];
  referenceClass: EventInput["referenceClass"];
  marketSymbols: string[];
  polymarketMarketId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapEventRow(row: Record<string, unknown>): EventRecord {
  const referenceClassResult = ReferenceClassSchema.nullable().safeParse(
    row.reference_class === undefined ? null : row.reference_class,
  );

  if (!referenceClassResult.success) {
    throw new Error(`Unexpected reference_class value in events row: ${String(row.reference_class)}`);
  }

  return {
    id: String(row.id),
    question: String(row.question),
    resolutionCriteria: String(row.resolution_criteria),
    deadline: toIsoString(row.deadline),
    status: String(row.status),
    entities: Array.isArray(row.entities) ? (row.entities as string[]) : [],
    referenceClass: referenceClassResult.data,
    marketSymbols: Array.isArray(row.market_symbols) ? (row.market_symbols as string[]) : [],
    polymarketMarketId:
      row.polymarket_market_id === null || row.polymarket_market_id === undefined
        ? null
        : String(row.polymarket_market_id),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export async function createEvent(pool: Pool, input: EventInput): Promise<EventRecord> {
  const id = randomUUID();
  const result = await pool.query(
    `
      INSERT INTO events (
        id,
        question,
        resolution_criteria,
        deadline,
        entities,
        reference_class,
        market_symbols,
        polymarket_market_id
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
      RETURNING *
    `,
    [
      id,
      input.question,
      input.resolutionCriteria,
      input.deadline,
      JSON.stringify(input.entities),
      input.referenceClass,
      JSON.stringify(input.marketSymbols),
      input.polymarketMarketId ?? null,
    ],
  );

  return mapEventRow(result.rows[0] as Record<string, unknown>);
}

export async function getEventById(pool: Pool, id: string): Promise<EventRecord | null> {
  const result = await pool.query(`SELECT * FROM events WHERE id = $1`, [id]);

  if (result.rowCount === 0) {
    return null;
  }

  return mapEventRow(result.rows[0] as Record<string, unknown>);
}
