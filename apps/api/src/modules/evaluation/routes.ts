import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { z } from "zod";

import type { EvaluationRun } from "@cassandra/shared";

import type { AppEnv } from "../../config/env.js";
import { createEvidenceCacheStore, createJudgeCacheStore } from "../judgments/service.js";
import { importAndStoreResolvedPolymarketBenchmarks } from "./polymarketImport.js";
import { getEvaluationRunById } from "./repository.js";
import { runHistoricalEvaluation, type RunHistoricalEvaluationInput } from "./replay.js";

const BaselineNameSchema = z.enum([
  "base_rate_only",
  "polymarket_only",
  "model_without_polymarket",
  "model_with_polymarket",
]);

const CreateEvaluationRunInputSchema = z
  .object({
    benchmarkSetId: z.string().min(1),
    benchmarkMarketIds: z.array(z.string().min(1)).min(1).optional(),
    baselines: z.array(BaselineNameSchema).min(1).optional(),
  })
  .strict();

export interface RegisterEvaluationRoutesArgs {
  pool: Pool;
  env: AppEnv;
  fetchImpl?: typeof fetch;
  redisConnection?: Redis;
  runEvaluation?: (input: RunHistoricalEvaluationInput) => Promise<EvaluationRun>;
  getEvaluationRun?: (runId: string) => Promise<EvaluationRun | null>;
}

export function registerEvaluationRoutes(
  app: FastifyInstance,
  args: RegisterEvaluationRoutesArgs,
) {
  const evidenceCacheStore = createEvidenceCacheStore(args.redisConnection);
  const judgeCacheStore = createJudgeCacheStore(args.redisConnection);
  const runEvaluation =
    args.runEvaluation ??
    ((input: RunHistoricalEvaluationInput) =>
      runHistoricalEvaluation({
        pool: args.pool,
        env: args.env,
        input,
        evidenceCacheStore,
        judgeCacheStore,
      }));
  const getEvaluationRun =
    args.getEvaluationRun ?? ((runId: string) => getEvaluationRunById(args.pool, runId));

  app.post("/evaluation/benchmarks/import/polymarket", async (_request, reply) => {
    const markets = await importAndStoreResolvedPolymarketBenchmarks({
      pool: args.pool,
      baseUrl: args.env.POLYMARKET_GAMMA_URL,
      fetchImpl: args.fetchImpl,
    });

    reply.code(201);
    return {
      imported: markets.length,
      markets,
    };
  });

  app.post("/evaluation/runs", async (request, reply) => {
    const parsed = CreateEvaluationRunInputSchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid evaluation run input",
        issues: parsed.error.issues,
      };
    }

    const run = await runEvaluation(parsed.data);
    reply.code(201);
    return run;
  });

  app.get("/evaluation/runs/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const runId = params.id;

    if (!runId) {
      reply.code(400);
      return {
        error: "Missing evaluation run id",
      };
    }

    const run = await getEvaluationRun(runId);

    if (!run) {
      reply.code(404);
      return {
        error: "Evaluation run not found",
      };
    }

    return run;
  });
}
