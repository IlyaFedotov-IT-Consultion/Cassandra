import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { countOutcomes } from "../outcomes/repository.js";
import { retrainCalibrationSnapshot } from "./repository.js";

export function registerBacktestRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/backtests/retrain", async (_request, reply) => {
    const resolvedOutcomeCount = await countOutcomes(pool);
    const snapshot = await retrainCalibrationSnapshot(pool, resolvedOutcomeCount);

    reply.code(201);
    return snapshot;
  });
}
