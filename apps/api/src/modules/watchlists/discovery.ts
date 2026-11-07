import type { WatchlistDiscoveryResult } from "@cassandra/shared";

import { normalizeEvidenceItems } from "../evidence/normalize.js";
import type { AdapterMode, EvidenceProvider } from "../evidence/types.js";
import type { CandidateEventRecord, WatchlistRecord } from "./repository.js";
import { upsertCandidateEvent } from "./repository.js";
import { clusterCandidateEvidence } from "./cluster.js";
import type { Pool } from "pg";

/** Serialises to the shared `WatchlistDiscoveryResult` wire contract; keeps the API's typed candidate signature. */
export interface WatchlistDiscoveryOutcome {
  candidates: CandidateEventRecord[];
  failedProviders: WatchlistDiscoveryResult["failedProviders"];
}

// Which evidence providers each watchlist source toggle controls. Providers without a toggle
// (general web search, Perplexity) always run.
const PROVIDERS_BY_SOURCE_TOGGLE: Record<string, readonly string[]> = {
  official: ["officialSearch"],
  government: ["governmentSearch"],
  community: ["communitySearch"],
  markets: ["marketProvider"],
  predictionMarkets: ["polymarketGamma", "polymarketClob"],
};

/** Drops providers whose source the watchlist explicitly switched off; an absent toggle means on. */
export function selectWatchlistProviders(
  providers: EvidenceProvider[],
  sourceToggles: Record<string, boolean>,
): EvidenceProvider[] {
  const disabled = new Set(
    Object.entries(PROVIDERS_BY_SOURCE_TOGGLE)
      .filter(([toggle]) => sourceToggles[toggle] === false)
      .flatMap(([, providerNames]) => providerNames),
  );

  return providers.filter((provider) => !disabled.has(provider.name));
}

export async function discoverWatchlistCandidates(args: {
  pool: Pool;
  watchlist: WatchlistRecord;
  providers: EvidenceProvider[];
  evaluationTime: string;
  mode: AdapterMode;
}): Promise<WatchlistDiscoveryOutcome> {
  const providers = selectWatchlistProviders(args.providers, args.watchlist.sourceToggles);
  // One slow or failing source (live search, Polymarket) must not discard what the others found.
  const settled = await Promise.allSettled(
    providers.map((provider) =>
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
  const failedProviders = settled.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [
          {
            providerName: providers[index]!.name,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          },
        ]
      : [],
  );
  const rawEvidence = settled.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));

  const normalizedEvidence = normalizeEvidenceItems(rawEvidence).map((item) => ({
    ...item,
    eventId: args.watchlist.id,
  }));
  const clusters = clusterCandidateEvidence(normalizedEvidence);

  const candidates = await Promise.all(
    clusters.map((cluster) =>
      upsertCandidateEvent(args.pool, {
        watchlistId: args.watchlist.id,
        title: cluster.title,
        description: cluster.description,
        supportingEvidenceIds: cluster.supportingEvidenceIds,
        clusterKey: cluster.clusterKey,
        candidateSignature: cluster.candidateSignature,
      }),
    ),
  );

  return { candidates, failedProviders };
}
