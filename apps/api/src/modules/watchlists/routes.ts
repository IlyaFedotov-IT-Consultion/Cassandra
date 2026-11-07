import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { WatchlistInputSchema } from "@cassandra/shared";

import type { AppEnv } from "../../config/env.js";
import type { EvidenceProvider } from "../evidence/types.js";
import { createDefaultEvidenceProviders } from "../judgments/service.js";
import { runWatchlistDiscovery } from "./discovery.js";
import {
  createWatchlist,
  getWatchlistById,
  listCandidateEventsForWatchlist,
  listWatchlists,
} from "./repository.js";
import { cadenceToIntervalMs, type WatchlistDiscoveryScheduler } from "./schedule.js";

export function registerWatchlistRoutes(
  app: FastifyInstance,
  args: {
    pool: Pool;
    env: AppEnv;
    /** Overrides the configured evidence providers (tests, fixtures). */
    evidenceProviders?: EvidenceProvider[];
    /** Absent when scheduled discovery is switched off; watchlists then run only on demand. */
    discoveryScheduler?: WatchlistDiscoveryScheduler;
  },
) {
  const { pool, env } = args;
  const logger = app.log.child({ area: "watchlists" });
  app.get("/watchlists", async () => listWatchlists(pool));

  app.get("/watchlists/:id", async (request, reply) => {
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

    return watchlist;
  });

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

  app.get("/watchlists/:id/schedule", async (request, reply) => {
    const { id: watchlistId } = request.params as { id?: string };
    const watchlist = watchlistId ? await getWatchlistById(pool, watchlistId) : null;

    if (!watchlist) {
      reply.code(404);
      return {
        error: "Watchlist not found",
      };
    }

    return args.discoveryScheduler
      ? args.discoveryScheduler.describe(watchlist)
      : { cadence: watchlist.cadence, intervalMs: cadenceToIntervalMs(watchlist.cadence), nextRunAt: null };
  });

  // Runs discovery inline: it only collects and clusters evidence (no judge call), so it fits one request.
  app.post("/watchlists/:id/discover", async (request, reply) => {
    const { id: watchlistId } = request.params as { id?: string };
    const watchlist = watchlistId ? await getWatchlistById(pool, watchlistId) : null;

    if (!watchlist) {
      reply.code(404);
      return {
        error: "Watchlist not found",
      };
    }

    const result = await runWatchlistDiscovery({
      pool,
      watchlist,
      providers: args.evidenceProviders ?? createDefaultEvidenceProviders(env),
      evaluationTime: new Date().toISOString(),
      mode: env.CASSANDRA_ADAPTER_MODE,
      trigger: "manual",
    });

    for (const failure of result.failedProviders) {
      logger.warn(
        { event: "watchlist_discovery_provider_failed", watchlistId: watchlist.id, ...failure },
        "watchlist discovery provider failed",
      );
    }

    return result;
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

    try {
      await args.discoveryScheduler?.sync(watchlist);
    } catch (error) {
      // The watchlist is saved either way; the next API start re-syncs every schedule.
      logger.warn(
        { event: "watchlist_schedule_sync_failed", watchlistId: watchlist.id, err: error },
        "watchlist schedule sync failed",
      );
    }

    reply.code(201);
    return watchlist;
  });
}
