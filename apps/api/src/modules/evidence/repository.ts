import { createHash } from "node:crypto";

import type { EvidenceItem } from "@cassandra/shared";
import type { Pool } from "pg";

export interface EvidenceRecord extends EvidenceItem {
  createdAt: string;
  updatedAt: string;
}

/**
 * What an evidence item says, as opposed to when it was fetched. `retrievedAt` is left out,
 * and so is `publishedAt` when it is only a retrieval-time placeholder for an undated item.
 */
function evidenceContentHash(item: EvidenceItem): string {
  const undated = item.metadata.publishedAtSource === "unknown";

  return createHash("sha256")
    .update(
      JSON.stringify([
        item.sourceFamily,
        item.sourceType,
        item.title,
        item.publisher,
        undated ? null : new Date(item.publishedAt).toISOString(),
        item.summary,
        item.rawText,
        item.entities,
        item.claims,
        item.stance,
        item.qualitySignals,
        item.metadata,
      ]),
    )
    .digest("hex");
}

/** A row is one version of one URL for one event; identical content maps to the same row. */
function buildEvidenceStorageId(item: EvidenceItem): string {
  const hex = createHash("sha1")
    .update(`${item.eventId}:${item.url}:${evidenceContentHash(item)}`)
    .digest("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapEvidenceRow(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    sourceFamily: row.source_family as EvidenceItem["sourceFamily"],
    sourceType: row.source_type as EvidenceItem["sourceType"],
    title: String(row.title),
    url: String(row.url),
    publisher: String(row.publisher),
    publishedAt: toIsoString(row.published_at),
    retrievedAt: toIsoString(row.retrieved_at),
    summary: String(row.summary),
    rawText: row.raw_text === null ? null : String(row.raw_text),
    entities: Array.isArray(row.entities) ? (row.entities as string[]) : [],
    claims: Array.isArray(row.claims) ? (row.claims as string[]) : [],
    stance: row.stance as EvidenceItem["stance"],
    qualitySignals:
      row.quality_signals && typeof row.quality_signals === "object"
        ? (row.quality_signals as Record<string, unknown>)
        : {},
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * Stores evidence without ever changing a stored row. Traces cite evidence by id, so a row
 * a past judgment read must keep saying what it said then: unchanged content reuses its
 * row, and changed content (a revised page, a new market quote) becomes a new row.
 */
export async function insertEvidenceItems(
  pool: Pool,
  items: EvidenceItem[],
): Promise<EvidenceRecord[]> {
  const stored: EvidenceRecord[] = [];

  for (const item of items) {
    const id = buildEvidenceStorageId(item);
    const inserted = await pool.query(
      `
        INSERT INTO evidence_items (
          id,
          event_id,
          source_family,
          source_type,
          title,
          url,
          publisher,
          published_at,
          retrieved_at,
          summary,
          raw_text,
          entities,
          claims,
          stance,
          quality_signals,
          metadata
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12::jsonb, $13::jsonb, $14, $15::jsonb, $16::jsonb
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `,
      [
        id,
        item.eventId,
        item.sourceFamily,
        item.sourceType,
        item.title,
        item.url,
        item.publisher,
        item.publishedAt,
        item.retrievedAt,
        item.summary,
        item.rawText,
        JSON.stringify(item.entities),
        JSON.stringify(item.claims),
        item.stance,
        JSON.stringify(item.qualitySignals),
        JSON.stringify(item.metadata),
      ],
    );
    const row =
      inserted.rows[0] ?? (await pool.query(`SELECT * FROM evidence_items WHERE id = $1`, [id])).rows[0];

    stored.push(mapEvidenceRow(row as Record<string, unknown>));
  }

  return stored;
}

export async function listEvidenceForEvent(
  pool: Pool,
  eventId: string,
): Promise<EvidenceRecord[]> {
  const result = await pool.query(
    `SELECT * FROM evidence_items WHERE event_id = $1 ORDER BY published_at ASC, created_at ASC`,
    [eventId],
  );

  return result.rows.map((row) => mapEvidenceRow(row as Record<string, unknown>));
}
