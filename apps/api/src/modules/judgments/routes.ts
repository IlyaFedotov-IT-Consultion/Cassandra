import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { z } from "zod";
import {
  JudgmentExecutionLogLevelSchema,
  JudgmentExecutionStageSchema,
  JudgmentStatusSchema,
} from "@cassandra/shared";

import type { AppEnv } from "../../config/env.js";
import { runJudgmentWorker } from "../../workers/judgmentWorker.js";
import { listJudgments } from "./repository.js";
import {
  LIVE_AUTHORITATIVE_SEARCH_PROVIDER_REQUIRED_MESSAGE,
  assertLiveAuthoritativeSearchProviderConfigured,
  createEvidenceCacheStore,
  createJudgeCacheStore,
  enqueueJudgmentRun,
  getJudgmentDetails,
  listRuntimeEvents,
} from "./service.js";

const CreateJudgmentInputSchema = z
  .object({
    eventId: z.string().min(1),
    evaluationTime: z.string().min(1).optional(),
  })
  .strict();

const RuntimeQuerySchema = z
  .object({
    search: z.string().trim().optional(),
    judgmentStatus: JudgmentStatusSchema.optional(),
    stage: JudgmentExecutionStageSchema.optional(),
    level: JudgmentExecutionLogLevelSchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
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
  const logger = app.log.child({
    area: "judgments",
  });

  app.get("/judgments", async (request) => {
    const query = request.query as { eventId?: string };
    return listJudgments(args.pool, query.eventId);
  });

  app.get("/runtime", async (request, reply) => {
    const parsed = RuntimeQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid runtime query",
        issues: parsed.error.issues,
      };
    }

    return listRuntimeEvents(args.pool, parsed.data);
  });

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
      assertLiveAuthoritativeSearchProviderConfigured(args.env);
      const judgment = await enqueueJudgmentRun(args.pool, parsed.data.eventId);
      logger.info(
        {
          event: "judgment_enqueued",
          eventId: judgment.eventId,
          judgmentId: judgment.id,
        },
        "judgment enqueued",
      );

      setTimeout(() => {
        void runJudgmentWorker({
          pool: args.pool,
          env: args.env,
          evidenceCacheStore,
          judgeCacheStore,
          logger: logger.child({
            eventId: judgment.eventId,
            judgmentId: judgment.id,
          }),
          input: {
            ...parsed.data,
            judgmentId: judgment.id,
          },
        }).catch((error) => {
          logger.error(
            {
              event: "judgment_worker_failed",
              err: error,
              eventId: judgment.eventId,
              judgmentId: judgment.id,
            },
            "judgment worker failed",
          );
        });
      }, 0);

      reply.code(202);
      return {
        ...judgment,
        judgeOpinions: [],
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === LIVE_AUTHORITATIVE_SEARCH_PROVIDER_REQUIRED_MESSAGE
      ) {
        reply.code(409);
        return {
          error: error.message,
        };
      }

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
