import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { OutcomeInputSchema } from "@cassandra/shared";

import { createOutcome } from "./repository.js";

export function registerOutcomeRoutes(app: FastifyInstance, pool: Pool) {
  app.post("/outcomes", async (request, reply) => {
    const parsed = OutcomeInputSchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid outcome input",
        issues: parsed.error.issues,
      };
    }

    const outcome = await createOutcome(pool, parsed.data);

    reply.code(201);
    return outcome;
  });
}
