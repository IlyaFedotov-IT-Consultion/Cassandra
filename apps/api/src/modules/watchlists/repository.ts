import { randomUUID } from "node:crypto";

import type { CandidateEvent, WatchlistInput } from "@cassandra/shared";
import type { Pool } from "pg";

export interface WatchlistRecord {
  id: string;
  name: string;
  keywords: string[];
  jurisdictions: string[];
  cadence: string;
  sourceToggles: Record<string, boolean>;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapWatchlistRow(row: Record<string, unknown>): WatchlistRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    keywords: Array.isArray(row.keywords) ? (row.keywords as string[]) : [],
    jurisdictions: Array.isArray(row.jurisdictions) ? (row.jurisdictions as string[]) : [],
    cadence: String(row.cadence),
    sourceToggles:
      row.source_toggles && typeof row.source_toggles === "object"
        ? (row.source_toggles as Record<string, boolean>)
        : {},
    status: String(row.status),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapCandidateEventRow(row: Record<string, unknown>): CandidateEvent {
  return {
    id: String(row.id),
    watchlistId: String(row.watchlist_id),
    title: String(row.title),
    description: String(row.description),
    supportingEvidenceIds: Array.isArray(row.supporting_evidence_ids)
      ? (row.supporting_evidence_ids as string[])
      : [],
    clusterKey: String(row.cluster_key),
    promotionStatus: row.promotion_status as CandidateEvent["promotionStatus"],
  };
}

export async function createWatchlist(
  pool: Pool,
  input: WatchlistInput,
): Promise<WatchlistRecord> {
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

  return mapWatchlistRow(result.rows[0] as Record<string, unknown>);
}

export async function listWatchlists(pool: Pool): Promise<WatchlistRecord[]> {
  const result = await pool.query(`SELECT * FROM watchlists ORDER BY created_at DESC`);

  return result.rows.map((row) => mapWatchlistRow(row as Record<string, unknown>));
}

export async function getWatchlistById(
  pool: Pool,
  id: string,
): Promise<WatchlistRecord | null> {
  const result = await pool.query(`SELECT * FROM watchlists WHERE id = $1`, [id]);

  if (result.rowCount === 0) {
    return null;
  }

  return mapWatchlistRow(result.rows[0] as Record<string, unknown>);
}

export async function listCandidateEventsForWatchlist(
  pool: Pool,
  watchlistId: string,
): Promise<CandidateEvent[]> {
  const result = await pool.query(
    `
      SELECT *
      FROM candidate_events
      WHERE watchlist_id = $1
      ORDER BY created_at DESC
    `,
    [watchlistId],
  );

  return result.rows.map((row) => mapCandidateEventRow(row as Record<string, unknown>));
}
