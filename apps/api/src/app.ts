import Fastify from "fastify";

export interface ReadinessChecks {
  checkDb?: () => Promise<void>;
  checkRedis?: () => Promise<void>;
}

export function buildApp(checks: ReadinessChecks = {}) {
  const app = Fastify({
    logger: false,
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

  return app;
}
