import type { EvidenceItem } from "@cassandra/shared";
import type { Pool } from "pg";

import type { EventRecord } from "../events/repository.js";
import type { EvidenceRecord } from "./repository.js";

export type AdapterMode = "live" | "fixture";
export type ProviderCacheStatus = "hit" | "miss" | "bypass";

export interface CollectEvidenceInput {
  event: EventRecord;
  evaluationTime: string;
  mode: AdapterMode;
}

export interface EvidenceProvider {
  name: string;
  collect(input: CollectEvidenceInput): Promise<EvidenceItem[]>;
}

export interface ProviderRun {
  providerName: string;
  rawCount: number;
  normalizedCount: number;
  cacheStatus: ProviderCacheStatus;
  error?: string;
}

export interface CollectEvidenceArgs {
  pool: Pool;
  event: EventRecord;
  evaluationTime: string;
  mode: AdapterMode;
  providers: EvidenceProvider[];
}

export interface CollectEvidenceResult {
  items: EvidenceRecord[];
  normalizedItems: EvidenceItem[];
  providerRuns: ProviderRun[];
}
