import { randomUUID } from "node:crypto";

import type { CalibrationSnapshot } from "@cassandra/shared";
import type { Pool } from "pg";

const DEFAULT_JUDGE_WEIGHTS = {
  official_records: 1 / 3,
  community_signal: 1 / 3,
  open_web_research: 1 / 3,
};

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapCalibrationSnapshotRow(row: Record<string, unknown>): CalibrationSnapshot {
  return {
    id: String(row.id),
    createdAt: toIsoString(row.created_at),
    trainingWindow: String(row.training_window),
    judgeWeights:
      row.judge_weights && typeof row.judge_weights === "object"
        ? (row.judge_weights as Record<string, unknown>)
        : {},
    baseRateParams:
      row.base_rate_params && typeof row.base_rate_params === "object"
        ? (row.base_rate_params as Record<string, unknown>)
        : {},
    marketPriorParams:
      row.market_prior_params && typeof row.market_prior_params === "object"
        ? (row.market_prior_params as Record<string, unknown>)
        : {},
    calibrationParams:
      row.calibration_params && typeof row.calibration_params === "object"
        ? (row.calibration_params as Record<string, unknown>)
        : {},
    onlineLearningParams:
      row.online_learning_params && typeof row.online_learning_params === "object"
        ? (row.online_learning_params as Record<string, unknown>)
        : {},
    metrics:
      row.metrics && typeof row.metrics === "object"
        ? (row.metrics as Record<string, unknown>)
        : {},
    weightRegime: row.weight_regime as CalibrationSnapshot["weightRegime"],
    resolvedOutcomeCount: Number(row.resolved_outcome_count),
    approved: Boolean(row.approved),
  };
}

export function selectWeightRegime(
  resolvedOutcomeCount: number,
): CalibrationSnapshot["weightRegime"] {
  if (resolvedOutcomeCount >= 100) {
    return "steady";
  }

  if (resolvedOutcomeCount >= 20) {
    return "warming";
  }

  return "cold_start";
}

export async function createCalibrationSnapshot(
  pool: Pool,
  snapshot: Omit<CalibrationSnapshot, "id" | "createdAt">,
): Promise<CalibrationSnapshot> {
  const result = await pool.query(
    `
      INSERT INTO calibration_snapshots (
        id,
        training_window,
        judge_weights,
        base_rate_params,
        market_prior_params,
        calibration_params,
        online_learning_params,
        metrics,
        weight_regime,
        resolved_outcome_count,
        approved
      )
      VALUES (
        $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb,
        $7::jsonb, $8::jsonb, $9, $10, $11
      )
      RETURNING *
    `,
    [
      randomUUID(),
      snapshot.trainingWindow,
      JSON.stringify(snapshot.judgeWeights),
      JSON.stringify(snapshot.baseRateParams),
      JSON.stringify(snapshot.marketPriorParams),
      JSON.stringify(snapshot.calibrationParams),
      JSON.stringify(snapshot.onlineLearningParams),
      JSON.stringify(snapshot.metrics),
      snapshot.weightRegime,
      snapshot.resolvedOutcomeCount,
      snapshot.approved,
    ],
  );

  return mapCalibrationSnapshotRow(result.rows[0] as Record<string, unknown>);
}

export async function retrainCalibrationSnapshot(
  pool: Pool,
  resolvedOutcomeCount: number,
): Promise<CalibrationSnapshot> {
  const weightRegime = selectWeightRegime(resolvedOutcomeCount);
  const calibrationMethod =
    weightRegime === "steady"
      ? "isotonic"
      : weightRegime === "warming"
        ? "logistic"
        : "identity";

  return createCalibrationSnapshot(pool, {
    trainingWindow: "all_time",
    judgeWeights: DEFAULT_JUDGE_WEIGHTS,
    baseRateParams: {},
    marketPriorParams: {},
    calibrationParams: {
      method: calibrationMethod,
    },
    onlineLearningParams: {
      enabled: weightRegime !== "cold_start",
      stepSizeScale: weightRegime === "warming" ? 0.5 : weightRegime === "steady" ? 1 : 0,
    },
    metrics: {},
    weightRegime,
    resolvedOutcomeCount,
    approved: false,
  });
}
