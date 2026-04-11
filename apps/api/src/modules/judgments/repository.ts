import { randomUUID } from "node:crypto";

import type { JudgeOpinion, VerdictTrace } from "@cassandra/shared";
import type { Pool } from "pg";

export interface JudgmentRecord {
  id: string;
  eventId: string;
  status: string;
  verdictTrace: VerdictTrace | null;
  createdAt: string;
  updatedAt: string;
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapJudgmentRow(row: Record<string, unknown>): JudgmentRecord {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    status: String(row.status),
    verdictTrace:
      row.verdict_trace && typeof row.verdict_trace === "object"
        ? (row.verdict_trace as VerdictTrace)
        : null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapJudgeOpinionRow(row: Record<string, unknown>): JudgeOpinion {
  return {
    id: String(row.id),
    judgmentId: String(row.judgment_id),
    judgeName: String(row.judge_name),
    probability: Number(row.probability),
    confidence: Number(row.confidence),
    evidenceStrength: row.evidence_strength as JudgeOpinion["evidenceStrength"],
    rationale: String(row.rationale),
    evidenceIds: Array.isArray(row.evidence_ids) ? (row.evidence_ids as string[]) : [],
    warnings: Array.isArray(row.warnings) ? (row.warnings as string[]) : [],
    logBayesFactor: Number(row.log_bayes_factor),
    baseWeight: Number(row.base_weight),
    dependencyDiscount: Number(row.dependency_discount),
    freshnessDecay: Number(row.freshness_decay),
    effectiveLogOddsContribution: Number(row.effective_log_odds_contribution),
    missingEvidence: Array.isArray(row.missing_evidence)
      ? (row.missing_evidence as string[])
      : [],
  };
}

export async function createJudgmentRun(
  pool: Pool,
  eventId: string,
): Promise<JudgmentRecord> {
  const result = await pool.query(
    `
      INSERT INTO judgments (id, event_id, status)
      VALUES ($1, $2, 'queued')
      RETURNING *
    `,
    [randomUUID(), eventId],
  );

  return mapJudgmentRow(result.rows[0] as Record<string, unknown>);
}

export async function appendJudgmentTrace(
  pool: Pool,
  judgmentId: string,
  verdictTrace: VerdictTrace,
): Promise<void> {
  await pool.query("BEGIN");

  try {
    await pool.query(
      `
        UPDATE judgments
        SET status = $2, verdict_trace = $3::jsonb, updated_at = NOW()
        WHERE id = $1
      `,
      [judgmentId, verdictTrace.status, JSON.stringify(verdictTrace)],
    );

    await pool.query(`DELETE FROM judge_opinions WHERE judgment_id = $1`, [judgmentId]);

    for (const opinion of verdictTrace.judgeOpinions) {
      await pool.query(
        `
          INSERT INTO judge_opinions (
            id,
            judgment_id,
            judge_name,
            probability,
            confidence,
            evidence_strength,
            rationale,
            evidence_ids,
            warnings,
            log_bayes_factor,
            base_weight,
            dependency_discount,
            freshness_decay,
            effective_log_odds_contribution,
            missing_evidence
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
            $11, $12, $13, $14, $15::jsonb
          )
        `,
        [
          opinion.id ?? randomUUID(),
          judgmentId,
          opinion.judgeName,
          opinion.probability,
          opinion.confidence,
          opinion.evidenceStrength,
          opinion.rationale,
          JSON.stringify(opinion.evidenceIds),
          JSON.stringify(opinion.warnings),
          opinion.logBayesFactor,
          opinion.baseWeight,
          opinion.dependencyDiscount,
          opinion.freshnessDecay,
          opinion.effectiveLogOddsContribution,
          JSON.stringify(opinion.missingEvidence),
        ],
      );
    }

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

export async function getJudgmentById(
  pool: Pool,
  judgmentId: string,
): Promise<JudgmentRecord | null> {
  const result = await pool.query(`SELECT * FROM judgments WHERE id = $1`, [judgmentId]);

  if (result.rowCount === 0) {
    return null;
  }

  return mapJudgmentRow(result.rows[0] as Record<string, unknown>);
}

export async function listJudgeOpinionsForJudgment(
  pool: Pool,
  judgmentId: string,
): Promise<JudgeOpinion[]> {
  const result = await pool.query(
    `SELECT * FROM judge_opinions WHERE judgment_id = $1 ORDER BY created_at ASC`,
    [judgmentId],
  );

  return result.rows.map((row) => mapJudgeOpinionRow(row as Record<string, unknown>));
}
