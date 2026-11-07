import type { Pool } from "pg";

import type { AdapterMode, EvidenceProvider } from "../modules/evidence/types.js";
import {
  runWatchlistDiscovery,
  type WatchlistDiscoveryOutcome,
} from "../modules/watchlists/discovery.js";
import { getWatchlistById } from "../modules/watchlists/repository.js";

/**
 * Runs one scheduled discovery. Returns null when the watchlist no longer exists, so the caller can
 * drop its schedule instead of failing (and retrying) the job.
 */
export async function runWatchlistDiscoveryWorker(args: {
  pool: Pool;
  watchlistId: string;
  providers: EvidenceProvider[];
  evaluationTime: string;
  mode: AdapterMode;
}): Promise<WatchlistDiscoveryOutcome | null> {
  const watchlist = await getWatchlistById(args.pool, args.watchlistId);

  if (!watchlist) {
    return null;
  }

  return runWatchlistDiscovery({ ...args, watchlist, trigger: "scheduled" });
}
