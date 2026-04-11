import { randomUUID } from "node:crypto";

import type { CalibrationSnapshot } from "@cassandra/shared";
import type { Pool } from "pg";

export async function createCalibrationSnapshot(
  pool: Pool,
  snapshot: Omit<CalibrationSnapshot, "id" | "createdAt">,
) {
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

  return result.rows[0];
}
