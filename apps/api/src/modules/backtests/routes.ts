import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import type { AppEnv } from "../../config/env.js";
import {
  CalibrationApprovalBlockedError,
  approveCalibrationSnapshot,
  getCalibrationSnapshotById,
  listCalibrationSnapshots,
  loadCalibrationTrainingData,
  persistCalibrationSnapshotFromService,
  requestCalibrationSnapshot,
  retrainCalibrationSnapshot as retrainCalibrationSnapshotLocally,
} from "./repository.js";

const ApproveSnapshotInputSchema = z
  .object({
    /** Approve even though held-out scores do not show the calibration map helping. */
    force: z.boolean().optional(),
  })
  .strict();

export function registerBacktestRoutes(
  app: FastifyInstance,
  args: {
    pool: Pool;
    env: AppEnv;
  },
) {
  app.get("/backtests/calibration-snapshots", async () => listCalibrationSnapshots(args.pool));

  app.get("/backtests/calibration-snapshots/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const snapshotId = params.id;

    if (!snapshotId) {
      reply.code(400);
      return {
        error: "Missing calibration snapshot id",
      };
    }

    const snapshot = await getCalibrationSnapshotById(args.pool, snapshotId);

    if (!snapshot) {
      reply.code(404);
      return {
        error: "Calibration snapshot not found",
      };
    }

    return snapshot;
  });

  app.post("/backtests/calibration-snapshots/:id/approve", async (request, reply) => {
    const params = request.params as { id?: string };
    const snapshotId = params.id;

    if (!snapshotId) {
      reply.code(400);
      return {
        error: "Missing calibration snapshot id",
      };
    }

    const parsed = ApproveSnapshotInputSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid approval input",
        issues: parsed.error.issues,
      };
    }

    try {
      const snapshot = await approveCalibrationSnapshot(args.pool, snapshotId, {
        force: parsed.data.force,
      });

      if (!snapshot) {
        reply.code(404);
        return {
          error: "Calibration snapshot not found",
        };
      }

      return snapshot;
    } catch (error) {
      if (error instanceof CalibrationApprovalBlockedError) {
        reply.code(409);
        return {
          error: `${error.message} Send {"force": true} to approve it anyway.`,
        };
      }

      throw error;
    }
  });

  app.post("/backtests/retrain", async (_request, reply) => {
    const calibrationData = await loadCalibrationTrainingData(args.pool);
    const snapshot =
      args.env.CASSANDRA_ADAPTER_MODE === "fixture"
        ? await retrainCalibrationSnapshotLocally(args.pool, calibrationData.resolvedOutcomes.length)
        : await (async () => {
            const snapshotFromService = await requestCalibrationSnapshot({
              judgeBaseUrl: args.env.JUDGE_BASE_URL,
              historicalTraces: calibrationData.historicalTraces,
              resolvedOutcomes: calibrationData.resolvedOutcomes,
              marketPricePairs: calibrationData.marketPricePairs,
            });

            return persistCalibrationSnapshotFromService(args.pool, snapshotFromService);
          })();

    reply.code(201);
    return snapshot;
  });
}
