import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type {
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";

import type { AppEnv } from "./config/env.js";
import { getEnv } from "./config/env.js";
import { createOriginAllowlist, hasValidApiKey } from "./lib/access.js";
import {
  buildRequestId,
  createLogger,
  resolveLogLevel,
  type AppLogger,
} from "./lib/logger.js";
import { registerBacktestRoutes } from "./modules/backtests/routes.js";
import {
  registerEvaluationRoutes,
  type RegisterEvaluationRoutesArgs,
} from "./modules/evaluation/routes.js";
import type { EvaluationJobQueue } from "./modules/evaluation/jobQueue.js";
import { registerEventRoutes } from "./modules/events/routes.js";
import type { EvidenceProvider } from "./modules/evidence/types.js";
import { registerJudgmentRoutes } from "./modules/judgments/routes.js";
import type { JudgmentJobQueue } from "./modules/judgments/jobQueue.js";
import { registerOutcomeRoutes } from "./modules/outcomes/routes.js";
import { registerResearchRoutes, type ResearchRunInput, type ResearchRunRecord } from "./modules/research/routes.js";
import { registerWatchlistRoutes } from "./modules/watchlists/routes.js";
import type { WatchlistDiscoveryScheduler } from "./modules/watchlists/schedule.js";

export interface ReadinessChecks {
  dbPool?: Pool;
  env?: AppEnv;
  redisConnection?: Redis;
  logger?: ReturnType<typeof createLogger>;
  fetchImpl?: typeof fetch;
  runResearch?: (input: ResearchRunInput) => Promise<ResearchRunRecord>;
  runEvaluation?: RegisterEvaluationRoutesArgs["runEvaluation"];
  getEvaluationRun?: RegisterEvaluationRoutesArgs["getEvaluationRun"];
  listBenchmarkSets?: RegisterEvaluationRoutesArgs["listBenchmarkSets"];
  judgmentQueue?: JudgmentJobQueue;
  evaluationQueue?: EvaluationJobQueue;
  watchlistEvidenceProviders?: EvidenceProvider[];
  watchlistDiscoveryScheduler?: WatchlistDiscoveryScheduler;
  checkDb?: () => Promise<void>;
  checkRedis?: () => Promise<void>;
}

/** Reachable without the API key, so health checks and probes keep working. */
const PUBLIC_PATHS = new Set(["/health", "/ready"]);

export function buildApp(checks: ReadinessChecks = {}) {
  const isTestMode = process.env.NODE_ENV === "test";
  const env =
    checks.env ??
    getEnv(
      isTestMode
        ? {
            ...process.env,
            LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
          }
        : process.env,
    );
  const logger =
    checks.logger ??
    createLogger({
      component: "api",
      level: isTestMode ? "silent" : resolveLogLevel(env.LOG_LEVEL),
    });
  const app: FastifyInstance = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    FastifyBaseLogger
  >({
    disableRequestLogging: true,
    genReqId(request) {
      return buildRequestId(request.headers["x-request-id"]);
    },
    loggerInstance: logger as unknown as FastifyBaseLogger,
    requestIdHeader: "x-request-id",
  });

  const isAllowedOrigin = createOriginAllowlist(env.CASSANDRA_CORS_ORIGINS);

  app.addHook("onRequest", async (request, reply) => {
    const requestLogger = request.log.child({
      component: "http",
      method: request.method,
      url: request.url,
    }) as AppLogger;
    requestLogger.info(
      {
        event: "request_received",
      },
      "request received",
    );

    const origin = request.headers.origin;

    if (origin) {
      // Any page the operator has open can send requests here, and in live mode a request
      // can start paid work, so only listed origins are served at all.
      if (!isAllowedOrigin(origin)) {
        return reply.code(403).send({
          error: `Origin ${origin} is not allowed to call this API. Add it to CASSANDRA_CORS_ORIGINS.`,
        });
      }

      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
      reply.header("access-control-allow-headers", "content-type,x-api-key,authorization");
      reply.header("vary", "origin");
    }

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }

    if (
      env.CASSANDRA_API_KEY &&
      !PUBLIC_PATHS.has(request.url.split("?")[0] ?? "") &&
      !hasValidApiKey(request.headers, env.CASSANDRA_API_KEY)
    ) {
      return reply.code(401).send({
        error: "Missing or invalid API key. Send it as x-api-key or as a bearer token.",
      });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    const requestLogger = request.log.child({
      component: "http",
      method: request.method,
      url: request.url,
    }) as AppLogger;
    requestLogger.info(
      {
        event: "request_completed",
        durationMs: reply.elapsedTime,
        statusCode: reply.statusCode,
      },
      "request completed",
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = reply.statusCode >= 400 ? reply.statusCode : 500;
    const requestLogger = request.log.child({
      component: "http",
      method: request.method,
      url: request.url,
    }) as AppLogger;

    requestLogger.error(
      {
        event: "request_failed",
        err: error,
        statusCode,
      },
      "request failed",
    );

    reply.code(statusCode).send(error);
  });

  app.get("/health", async () => ({
    status: "ok",
    adapterMode: env.CASSANDRA_ADAPTER_MODE,
  }));

  app.get("/ready", async (request, reply) => {
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
      request.log.child({
        component: "readiness",
      }).warn(
        {
          event: "readiness_check_failed",
          err: error,
        },
        "readiness check failed",
      );
      reply.code(503);

      return {
        status: "not_ready",
        error: error instanceof Error ? error.message : "Unknown readiness error",
      };
    }
  });

  registerResearchRoutes(app, {
    env,
    runResearch: checks.runResearch,
  });

  if (checks.dbPool) {
    registerEventRoutes(app, checks.dbPool);
    registerWatchlistRoutes(app, {
      pool: checks.dbPool,
      env,
      evidenceProviders: checks.watchlistEvidenceProviders,
      discoveryScheduler: checks.watchlistDiscoveryScheduler,
    });
    registerOutcomeRoutes(app, checks.dbPool);
    registerBacktestRoutes(app, {
      pool: checks.dbPool,
      env,
    });
    registerEvaluationRoutes(app, {
      pool: checks.dbPool,
      env,
      fetchImpl: checks.fetchImpl,
      redisConnection: checks.redisConnection,
      runEvaluation: checks.runEvaluation,
      evaluationQueue: checks.evaluationQueue,
      getEvaluationRun: checks.getEvaluationRun,
      listBenchmarkSets: checks.listBenchmarkSets,
    });
    registerJudgmentRoutes(app, {
      pool: checks.dbPool,
      env,
      redisConnection: checks.redisConnection,
      judgmentQueue: checks.judgmentQueue,
    });
  }

  return app;
}
