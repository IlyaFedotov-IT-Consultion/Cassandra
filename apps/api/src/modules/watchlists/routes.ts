import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { WatchlistInputSchema } from "@cassandra/shared";

import {
  createWatchlist,
  getWatchlistById,
  listCandidateEventsForWatchlist,
  listWatchlists,
} from "./repository.js";

export function registerWatchlistRoutes(app: FastifyInstance, pool: Pool) {
  app.get("/watchlists", async () => listWatchlists(pool));

  app.get("/watchlists/:id/candidates", async (request, reply) => {
    const params = request.params as { id?: string };
    const watchlistId = params.id;

    if (!watchlistId) {
      reply.code(400);
      return {
        error: "Missing watchlist id",
      };
    }

    const watchlist = await getWatchlistById(pool, watchlistId);

    if (!watchlist) {
      reply.code(404);
      return {
        error: "Watchlist not found",
      };
    }

    return listCandidateEventsForWatchlist(pool, watchlistId);
  });

  app.post("/watchlists", async (request, reply) => {
    const parsed = WatchlistInputSchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return {
        error: "Invalid watchlist input",
        issues: parsed.error.issues,
      };
    }

    const watchlist = await createWatchlist(pool, parsed.data);

    reply.code(201);
    return watchlist;
  });
}
