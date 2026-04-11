import { normalizeEvidenceItems } from "../evidence/normalize.js";
import type { AdapterMode, EvidenceProvider } from "../evidence/types.js";
import type { CandidateEventRecord, WatchlistRecord } from "./repository.js";
import { upsertCandidateEvent } from "./repository.js";
import { clusterCandidateEvidence } from "./cluster.js";
import type { Pool } from "pg";

export async function discoverWatchlistCandidates(args: {
  pool: Pool;
  watchlist: WatchlistRecord;
  providers: EvidenceProvider[];
  evaluationTime: string;
  mode: AdapterMode;
}): Promise<CandidateEventRecord[]> {
  const rawEvidence = await Promise.all(
    args.providers.map((provider) =>
      provider.collect({
        event: {
          id: args.watchlist.id,
          question: args.watchlist.keywords.join(" "),
          resolutionCriteria: args.watchlist.name,
          deadline: args.evaluationTime,
          status: args.watchlist.status,
          entities: args.watchlist.keywords,
          referenceClass: null,
          marketSymbols: [],
          polymarketMarketId: null,
          createdAt: args.watchlist.createdAt,
          updatedAt: args.watchlist.updatedAt,
        },
        evaluationTime: args.evaluationTime,
        mode: args.mode,
      }),
    ),
  );

  const normalizedEvidence = normalizeEvidenceItems(rawEvidence.flat()).map((item) => ({
    ...item,
    eventId: args.watchlist.id,
  }));
  const clusters = clusterCandidateEvidence(normalizedEvidence);

  return Promise.all(
    clusters.map((cluster) =>
      upsertCandidateEvent(args.pool, {
        watchlistId: args.watchlist.id,
        title: cluster.title,
        description: cluster.description,
        supportingEvidenceIds: cluster.supportingEvidenceIds,
        clusterKey: cluster.clusterKey,
      }),
    ),
  );
}
