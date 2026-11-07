import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import { OutcomeInputSchema } from "@cassandra/shared";

import { createOutcome, listOutcomes } from "./repository.js";

const OutcomeListQuerySchema = z
  .object({
    eventId: z.uuid().optional(),
  })
  .strict();

export function registerOutcomeRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/outcomes", async (request, reply) => {
    const parsed = OutcomeListQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid outcome query",
        issues: parsed.error.issues,
      };
    }

    return listOutcomes(pool, parsed.data.eventId);
  });

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
