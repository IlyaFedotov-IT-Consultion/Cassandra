import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AppEnv } from "../../config/env.js";
import {
  loadCalibrationTrainingData,
  persistCalibrationSnapshotFromService,
  requestCalibrationSnapshot,
} from "./repository.js";

export function registerBacktestRoutes(
  app: FastifyInstance,
  args: {
    pool: Pool;
    env: AppEnv;
  },
) {
  app.post("/backtests/retrain", async (_request, reply) => {
    const calibrationData = await loadCalibrationTrainingData(args.pool);
    const snapshotFromService = await requestCalibrationSnapshot({
      judgeBaseUrl: args.env.JUDGE_BASE_URL,
      historicalTraces: calibrationData.historicalTraces,
      resolvedOutcomes: calibrationData.resolvedOutcomes,
    });
    const snapshot = await persistCalibrationSnapshotFromService(args.pool, snapshotFromService);

    reply.code(201);
    return snapshot;
  });
}
