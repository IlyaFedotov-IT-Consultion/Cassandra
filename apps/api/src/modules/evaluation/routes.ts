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
import type { EvaluationJobQueue } from "./jobQueue.js";
import { importAndStoreResolvedPolymarketBenchmarks } from "./polymarketImport.js";
import {
  createQueuedEvaluationRun,
  failEvaluationRun,
  queueFailedEvaluationRun,
  getEvaluationRunById,
  listBenchmarkMarkets,
  listBenchmarkSets,
  listEvaluationPredictionsForRun,
  listEvaluationRuns,
  type BenchmarkSetSummary,
} from "./repository.js";
import {
  planEvaluationRun,
  runHistoricalEvaluation,
  type RunHistoricalEvaluationInput,
} from "./replay.js";

const BaselineNameSchema = z.enum([
  "base_rate_only",
  "polymarket_only",
  "model_without_polymarket",
  "model_with_polymarket",
]);

const ImportPolymarketBenchmarksInputSchema = z
  .object({
    benchmarkSetId: z.string().min(1).optional(),
    /** How many markets to keep. More markets give calibration more to learn from. */
    limit: z.number().int().min(1).max(500).optional(),
    /** How far back a market may have resolved, in days. */
    windowDays: z.number().int().min(1).max(365).optional(),
    /** The most markets kept from one theme, so one news cycle cannot dominate the set. */
    themeLimit: z.number().int().min(1).max(500).optional(),
    /** How many pages of 100 recently closed markets to scan for candidates. */
    pages: z.number().int().min(1).max(50).optional(),
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
  /** With a queue, runs are created queued and worked through in the background. */
  evaluationQueue?: EvaluationJobQueue;
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
        selection: {
          limit: parsed.data.limit,
          windowDays: parsed.data.windowDays,
          themeLimit: parsed.data.themeLimit,
          pages: parsed.data.pages,
        },
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

      if (args.evaluationQueue) {
        // A run is hours of model calls: it is queued, and the request answers at once.
        const plan = await planEvaluationRun({ pool: args.pool, input: parsed.data });
        const queued = await createQueuedEvaluationRun(args.pool, {
          benchmarkSetId: parsed.data.benchmarkSetId,
          baselines: plan.baselines,
          cutoffs: plan.cutoffs,
          request: { ...parsed.data, benchmarkMarketIds: plan.benchmarkMarketIds },
          totalMarkets: plan.totalMarkets,
        });

        try {
          await args.evaluationQueue.enqueue({ runId: queued.id });
        } catch (error) {
          await failEvaluationRun(args.pool, queued.id, error instanceof Error ? error.message : String(error));
          throw error;
        }
        reply.code(202);
        return queued;
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

  app.post("/evaluation/runs/:id/resume", async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid evaluation run id" });
    if (!args.evaluationQueue) return reply.code(503).send({ error: "Evaluation queue unavailable" });
    if (args.env.CASSANDRA_ADAPTER_MODE !== "live") {
      return reply.code(409).send({ error: LIVE_EVALUATION_REQUIRED_MESSAGE });
    }
    const run = await getEvaluationRun(parsed.data.id);
    if (!run) return reply.code(404).send({ error: "Evaluation run not found" });
    if (run.baselines.some((baseline) => baseline.startsWith("model_"))) {
      try {
        assertLiveAuthoritativeSearchProviderConfigured(args.env);
      } catch {
        return reply.code(409).send({ error: LIVE_AUTHORITATIVE_SEARCH_PROVIDER_REQUIRED_MESSAGE });
      }
    }
    // Claim atomically so double-clicks and concurrent callers cannot enqueue two paid runs.
    if (!await queueFailedEvaluationRun(args.pool, run.id)) {
      return reply.code(409).send({ error: "Only failed evaluation runs can be resumed" });
    }
    try {
      await args.evaluationQueue.enqueue({ runId: run.id });
    } catch (error) {
      await failEvaluationRun(args.pool, run.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return reply.code(202).send(await getEvaluationRun(run.id));
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
