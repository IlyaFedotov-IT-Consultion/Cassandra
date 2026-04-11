import Fastify from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

import type { AppEnv } from "./config/env.js";
import { getEnv } from "./config/env.js";
import { registerBacktestRoutes } from "./modules/backtests/routes.js";
import {
  registerEvaluationRoutes,
  type RegisterEvaluationRoutesArgs,
} from "./modules/evaluation/routes.js";
import { registerEventRoutes } from "./modules/events/routes.js";
import { registerJudgmentRoutes } from "./modules/judgments/routes.js";
import { registerOutcomeRoutes } from "./modules/outcomes/routes.js";
import { registerWatchlistRoutes } from "./modules/watchlists/routes.js";

export interface ReadinessChecks {
  dbPool?: Pool;
  env?: AppEnv;
  redisConnection?: Redis;
  fetchImpl?: typeof fetch;
  runEvaluation?: RegisterEvaluationRoutesArgs["runEvaluation"];
  getEvaluationRun?: RegisterEvaluationRoutesArgs["getEvaluationRun"];
  listBenchmarkSets?: RegisterEvaluationRoutesArgs["listBenchmarkSets"];
  checkDb?: () => Promise<void>;
  checkRedis?: () => Promise<void>;
}

export function buildApp(checks: ReadinessChecks = {}) {
  const app = Fastify({
    logger: false,
  });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;

    if (origin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
      reply.header("access-control-allow-headers", "content-type");
      reply.header("vary", "origin");
    }

    if (request.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  app.get("/health", async () => ({
    status: "ok",
  }));

  app.get("/ready", async (_request, reply) => {
    try {
      if (checks.checkDb) {
        await checks.checkDb();
      }

      if (checks.checkRedis) {
        await checks.checkRedis();
      }

      return {
        status: "ready",
      };
    } catch (error) {
      reply.code(503);

      return {
        status: "not_ready",
        error: error instanceof Error ? error.message : "Unknown readiness error",
      };
    }
  });

  if (checks.dbPool) {
    registerEventRoutes(app, checks.dbPool);
    registerWatchlistRoutes(app, checks.dbPool);
    registerOutcomeRoutes(app, checks.dbPool);
    registerBacktestRoutes(app, {
      pool: checks.dbPool,
      env: checks.env ?? getEnv(),
    });
    registerEvaluationRoutes(app, {
      pool: checks.dbPool,
      env: checks.env ?? getEnv(),
      fetchImpl: checks.fetchImpl,
      redisConnection: checks.redisConnection,
      runEvaluation: checks.runEvaluation,
      getEvaluationRun: checks.getEvaluationRun,
      listBenchmarkSets: checks.listBenchmarkSets,
    });
    registerJudgmentRoutes(app, {
      pool: checks.dbPool,
      env: checks.env ?? getEnv(),
      redisConnection: checks.redisConnection,
    });
  }

  return app;
}
