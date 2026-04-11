import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { EventInputSchema } from "@cassandra/shared";

import { createEvent, getEventById, listEvents } from "./repository.js";

export function registerEventRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/events", async () => listEvents(pool));

  app.get("/events/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const eventId = params.id;

    if (!eventId) {
      reply.code(400);
      return {
        error: "Missing event id",
      };
    }

    const event = await getEventById(pool, eventId);

    if (!event) {
      reply.code(404);
      return {
        error: "Event not found",
      };
    }

    return event;
  });

  app.post("/events", async (request, reply) => {
    const parsed = EventInputSchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid event input",
        issues: parsed.error.issues,
      };
    }

    const event = await createEvent(pool, parsed.data);

    reply.code(201);
    return event;
  });
}
