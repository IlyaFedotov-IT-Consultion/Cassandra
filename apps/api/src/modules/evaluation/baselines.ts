import type { CalibrationSnapshot, EvidenceItem, EvaluationRun } from "@cassandra/shared";

import type { EvidenceProvider } from "../evidence/types.js";
import type { BenchmarkPriceSnapshotRecord } from "./repository.js";

const POLYMARKET_PROVIDER_NAMES = new Set(["polymarketGamma", "polymarketClob"]);

export function providersForBaseline(
  baseline: EvaluationRun["baselines"][number],
  providers: EvidenceProvider[],
): EvidenceProvider[] {
  if (baseline !== "model_without_polymarket" && baseline !== "model_with_polymarket") {
    return providers;
  }

  return providers.filter((provider) => !POLYMARKET_PROVIDER_NAMES.has(provider.name));
}

export function assertNoPolymarketLeak(
  baseline: EvaluationRun["baselines"][number],
  evidence: EvidenceItem[],
): void {
  if (baseline !== "model_without_polymarket") {
    return;
  }

  const leaked = evidence.find((item) => {
    if (item.sourceFamily === "prediction_market") {
      return true;
    }

    const provider = item.metadata?.provider;
    return typeof provider === "string" && POLYMARKET_PROVIDER_NAMES.has(provider);
  });

  if (leaked) {
    throw new Error(
      `Polymarket evidence leaked into ${baseline}: ${leaked.id} (${leaked.sourceFamily})`,
    );
  }
}

export function selectPolymarketSnapshotAtCutoff(
  snapshots: BenchmarkPriceSnapshotRecord[],
  cutoffAt: string,
): BenchmarkPriceSnapshotRecord | null {
  const cutoffMillis = new Date(cutoffAt).getTime();
  const eligible = snapshots
    .filter(
      (snapshot) =>
        snapshot.source === "polymarket" && new Date(snapshot.cutoffAt).getTime() <= cutoffMillis,
    )
    .sort((left, right) => {
      const cutoffDelta =
        new Date(right.cutoffAt).getTime() - new Date(left.cutoffAt).getTime();

      if (cutoffDelta !== 0) {
        return cutoffDelta;
      }

      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });

  return eligible[0] ?? null;
}

export function computeBaseRateOnlyProbability(args: {
  referenceClass: string | null;
  calibrationSnapshot: CalibrationSnapshot;
}): number {
  const params = args.calibrationSnapshot.baseRateParams;
  const minimumSample =
    typeof params.minimumSample === "number" ? Math.max(1, params.minimumSample) : 20;
  const historicalCounts =
    params.historicalCounts && typeof params.historicalCounts === "object"
      ? (params.historicalCounts as Record<string, unknown>)
      : {};

  if (!args.referenceClass) {
    return 0.5;
  }

  const counts = historicalCounts[args.referenceClass];

  if (!counts || typeof counts !== "object") {
    return 0.5;
  }

  const countRecord = counts as Record<string, unknown>;
  const successes =
    typeof countRecord.successes === "number" ? Math.max(0, countRecord.successes) : 0;
  const total = typeof countRecord.total === "number" ? Math.max(0, countRecord.total) : 0;

  if (total <= 0) {
    return 0.5;
  }

  const smoothed = (successes + 1) / (total + 2);

  if (total < minimumSample) {
    return smoothed;
  }

  return smoothed;
}
