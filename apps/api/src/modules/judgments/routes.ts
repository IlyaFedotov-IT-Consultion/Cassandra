import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { z } from "zod";

import type { AppEnv } from "../../config/env.js";
import { runJudgmentWorker } from "../../workers/judgmentWorker.js";
import { listJudgments } from "./repository.js";
import {
  createEvidenceCacheStore,
  createJudgeCacheStore,
  enqueueJudgmentRun,
  getJudgmentDetails,
} from "./service.js";

const CreateJudgmentInputSchema = z
  .object({
    eventId: z.string().min(1),
    evaluationTime: z.string().min(1).optional(),
  })
  .strict();

export function registerJudgmentRoutes(
  app: FastifyInstance,
  args: {
    pool: Pool;
    env: AppEnv;
    redisConnection?: Redis;
  },
) {
  const evidenceCacheStore = createEvidenceCacheStore(args.redisConnection);
  const judgeCacheStore = createJudgeCacheStore(args.redisConnection);

  app.get("/judgments", async () => listJudgments(args.pool));

  app.get("/judgments/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const judgmentId = params.id;

    if (!judgmentId) {
      reply.code(400);
      return {
        error: "Missing judgment id",
      };
    }

    const judgment = await getJudgmentDetails(args.pool, judgmentId);

    if (!judgment) {
      reply.code(404);
      return {
        error: "Judgment not found",
      };
    }

    return judgment;
  });

  app.post("/judgments", async (request, reply) => {
    const parsed = CreateJudgmentInputSchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid judgment input",
        issues: parsed.error.issues,
      };
    }

    try {
      const judgment = await enqueueJudgmentRun(args.pool, parsed.data.eventId);

      setTimeout(() => {
        void runJudgmentWorker({
          pool: args.pool,
          env: args.env,
          evidenceCacheStore,
          judgeCacheStore,
          input: {
            ...parsed.data,
            judgmentId: judgment.id,
          },
        }).catch((error) => {
          app.log.error(error);
        });
      }, 0);

      reply.code(202);
      return {
        ...judgment,
        judgeOpinions: [],
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Event not found:")) {
        reply.code(404);
        return {
          error: "Event not found",
        };
      }

      throw error;
    }
  });
}
