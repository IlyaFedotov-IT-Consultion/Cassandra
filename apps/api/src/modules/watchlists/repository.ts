import { randomUUID } from "node:crypto";

import type { CandidateEvent, WatchlistDiscoveryRun, WatchlistInput } from "@cassandra/shared";
import type { Pool } from "pg";
import type { CandidateSignature } from "./cluster.js";

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
  lastDiscovery: WatchlistDiscoveryRun | null;
}

export interface CandidateEventRecord extends CandidateEvent {
  candidateSignature: CandidateSignature | null;
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
    lastDiscovery:
      row.last_discovery && typeof row.last_discovery === "object"
        ? (row.last_discovery as WatchlistDiscoveryRun)
        : null,
  };
}

function mapCandidateEventRow(row: Record<string, unknown>): CandidateEventRecord {
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
    candidateSignature:
      row.candidate_signature && typeof row.candidate_signature === "object"
        ? (row.candidate_signature as CandidateSignature)
        : null,
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
): Promise<CandidateEventRecord[]> {
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

export async function upsertCandidateEvent(
  pool: Pool,
  input: Omit<CandidateEvent, "id" | "promotionStatus"> & {
    candidateSignature: CandidateSignature;
    promotionStatus?: CandidateEvent["promotionStatus"];
  },
): Promise<CandidateEventRecord> {
  const existing = await pool.query(
    `
      SELECT *
      FROM candidate_events
      WHERE watchlist_id = $1 AND cluster_key = $2
      LIMIT 1
    `,
    [input.watchlistId, input.clusterKey],
  );

  if (existing.rowCount && existing.rows[0]) {
    const result = await pool.query(
      `
        UPDATE candidate_events
        SET
          title = $2,
          description = $3,
          supporting_evidence_ids = $4::jsonb,
          candidate_signature = $5::jsonb,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        existing.rows[0].id,
        input.title,
        input.description,
        JSON.stringify(input.supportingEvidenceIds),
        JSON.stringify(input.candidateSignature),
      ],
    );

    return mapCandidateEventRow(result.rows[0] as Record<string, unknown>);
  }

  const result = await pool.query(
    `
      INSERT INTO candidate_events (
        id,
        watchlist_id,
        title,
        description,
        supporting_evidence_ids,
        cluster_key,
        candidate_signature,
        promotion_status
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
      RETURNING *
    `,
    [
      randomUUID(),
      input.watchlistId,
      input.title,
      input.description,
      JSON.stringify(input.supportingEvidenceIds),
      input.clusterKey,
      JSON.stringify(input.candidateSignature),
      input.promotionStatus ?? "pending",
    ],
  );

  return mapCandidateEventRow(result.rows[0] as Record<string, unknown>);
}

/** Stores the outcome of the latest discovery run; `updated_at` is left alone because the watchlist itself did not change. */
export async function recordWatchlistDiscovery(
  pool: Pool,
  watchlistId: string,
  run: WatchlistDiscoveryRun,
): Promise<void> {
  await pool.query(`UPDATE watchlists SET last_discovery = $2::jsonb WHERE id = $1`, [
    watchlistId,
    JSON.stringify(run),
  ]);
}
