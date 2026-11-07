import type { Pool } from "pg";

import type { AdapterMode, EvidenceProvider } from "../modules/evidence/types.js";
import {
  discoverWatchlistCandidates,
  type WatchlistDiscoveryOutcome,
} from "../modules/watchlists/discovery.js";
import type { WatchlistRecord } from "../modules/watchlists/repository.js";

export async function runWatchlistDiscoveryWorker(args: {
  pool: Pool;
  watchlist: WatchlistRecord;
  providers: EvidenceProvider[];
  evaluationTime: string;
  mode: AdapterMode;
}): Promise<WatchlistDiscoveryOutcome> {
  return discoverWatchlistCandidates(args);
}
