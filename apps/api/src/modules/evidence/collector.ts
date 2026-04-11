import type { EvidenceItem } from "@cassandra/shared";

import { normalizeEvidenceItems } from "./normalize.js";
import { insertEvidenceItems } from "./repository.js";
import type { CollectEvidenceArgs, CollectEvidenceResult, ProviderRun } from "./types.js";

export async function collectEvidenceForEvent(
  args: CollectEvidenceArgs,
): Promise<CollectEvidenceResult> {
  const providerRuns: ProviderRun[] = [];
  const rawItems: EvidenceItem[] = [];

  for (const provider of args.providers) {
    const providerItems = await provider.collect({
      event: args.event,
      evaluationTime: args.evaluationTime,
      mode: args.mode,
    });

    rawItems.push(...providerItems);
    providerRuns.push({
      providerName: provider.name,
      rawCount: providerItems.length,
      normalizedCount: normalizeEvidenceItems(providerItems).length,
      cacheStatus: "bypass",
    });
  }

  const normalizedItems = normalizeEvidenceItems(rawItems);
  const items = await insertEvidenceItems(args.pool, normalizedItems);

  return {
    items,
    normalizedItems,
    providerRuns,
  };
}
