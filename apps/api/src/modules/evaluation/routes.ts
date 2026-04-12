import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { z } from "zod";

import type { EvaluationRun } from "@cassandra/shared";

import type { AppEnv } from "../../config/env.js";
import {
  LIVE_AUTHORITATIVE_SEARCH_PROVIDER_REQUIRED_MESSAGE,
  assertLiveAuthoritativeSearchProviderConfigured,
  createEvidenceCacheStore,
  createJudgeCacheStore,
} from "../judgments/service.js";
import {
  assertLiveEvaluationMode,
  LIVE_EVALUATION_REQUIRED_MESSAGE,
} from "./liveMode.js";
import { importAndStoreResolvedPolymarketBenchmarks } from "./polymarketImport.js";
import {
  getEvaluationRunById,
  listBenchmarkMarkets,
  listBenchmarkSets,
  listEvaluationPredictionsForRun,
  listEvaluationRuns,
  type BenchmarkSetSummary,
} from "./repository.js";
import { runHistoricalEvaluation, type RunHistoricalEvaluationInput } from "./replay.js";

const BaselineNameSchema = z.enum([
  "base_rate_only",
  "polymarket_only",
  "model_without_polymarket",
  "model_with_polymarket",
]);

const ImportPolymarketBenchmarksInputSchema = z
  .object({
    benchmarkSetId: z.string().min(1).optional(),
  })
  .strict();

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
  listBenchmarkSets?: () => Promise<BenchmarkSetSummary[]>;
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
  const getBenchmarkSets = args.listBenchmarkSets ?? (() => listBenchmarkSets(args.pool));

  app.post("/evaluation/benchmarks/import/polymarket", async (request, reply) => {
    const parsed = ImportPolymarketBenchmarksInputSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid benchmark import input",
        issues: parsed.error.issues,
      };
    }

    try {
      assertLiveEvaluationMode(args.env);
      const markets = await importAndStoreResolvedPolymarketBenchmarks({
        pool: args.pool,
        baseUrl: args.env.POLYMARKET_GAMMA_URL,
        clobBaseUrl: args.env.POLYMARKET_CLOB_URL,
        fetchImpl: args.fetchImpl,
        benchmarkSetId: parsed.data.benchmarkSetId,
        mode: args.env.CASSANDRA_ADAPTER_MODE,
      });

      reply.code(201);
      return {
        imported: markets.length,
        markets,
      };
    } catch (error) {
      if (error instanceof Error && error.message === LIVE_EVALUATION_REQUIRED_MESSAGE) {
        reply.code(409);
        return {
          error: error.message,
        };
      }

      if (
        error instanceof Error &&
        error.message.startsWith("Benchmark market ") &&
        error.message.includes(" already belongs to benchmark set ")
      ) {
        reply.code(409);
        return {
          error: error.message,
        };
      }

      throw error;
    }
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

    try {
      assertLiveEvaluationMode(args.env);
      const usesModelBaselines =
        !parsed.data.baselines ||
        parsed.data.baselines.some((baseline) =>
          baseline === "model_without_polymarket" || baseline === "model_with_polymarket",
        );

      if (usesModelBaselines) {
        assertLiveAuthoritativeSearchProviderConfigured(args.env);
      }
      const run = await runEvaluation(parsed.data);
      reply.code(201);
      return run;
    } catch (error) {
      if (error instanceof Error && error.message === LIVE_EVALUATION_REQUIRED_MESSAGE) {
        reply.code(409);
        return {
          error: error.message,
        };
      }

      if (
        error instanceof Error &&
        error.message === LIVE_AUTHORITATIVE_SEARCH_PROVIDER_REQUIRED_MESSAGE
      ) {
        reply.code(409);
        return {
          error: error.message,
        };
      }

      if (
        error instanceof Error &&
        (error.message === "No benchmark markets available for evaluation" ||
          error.message.startsWith("Benchmark markets not found: "))
      ) {
        reply.code(404);
        return {
          error: error.message,
        };
      }

      throw error;
    }
  });

  app.get("/evaluation/benchmark-sets", async () => getBenchmarkSets());

  app.get("/evaluation/benchmark-sets/:benchmarkSetId/markets", async (request, reply) => {
    const params = request.params as { benchmarkSetId?: string };
    const benchmarkSetId = params.benchmarkSetId;

    if (!benchmarkSetId) {
      reply.code(400);
      return {
        error: "Missing benchmark set id",
      };
    }

    return listBenchmarkMarkets(args.pool, benchmarkSetId);
  });

  app.get("/evaluation/runs", async () => listEvaluationRuns(args.pool));

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

  app.get("/evaluation/runs/:id/predictions", async (request, reply) => {
    const params = request.params as { id?: string };
    const runId = params.id;

    if (!runId) {
      reply.code(400);
      return {
        error: "Missing evaluation run id",
      };
    }

    return listEvaluationPredictionsForRun(args.pool, runId);
  });
}
