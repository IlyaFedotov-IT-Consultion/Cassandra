import type { Pool } from "pg";

import type { AdapterMode, EvidenceProvider } from "../modules/evidence/types.js";
import { discoverWatchlistCandidates } from "../modules/watchlists/discovery.js";
import type { CandidateEventRecord, WatchlistRecord } from "../modules/watchlists/repository.js";

export async function runWatchlistDiscoveryWorker(args: {
  pool: Pool;
  watchlist: WatchlistRecord;
  providers: EvidenceProvider[];
  evaluationTime: string;
  mode: AdapterMode;
}): Promise<CandidateEventRecord[]> {
  return discoverWatchlistCandidates(args);
}
