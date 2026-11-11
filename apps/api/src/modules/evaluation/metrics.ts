import type { EvaluationSliceResult } from "@cassandra/shared";

export interface EvaluationPair {
  predicted: number;
  outcome: number;
  baseline: EvaluationSliceResult["baseline"];
  theme?: string;
  horizon?: string;
  sourceConfiguration?: string;
  referencePredicted?: number;
}

export function brierScore(pairs: Array<Pick<EvaluationPair, "predicted" | "outcome">>): number {
  if (pairs.length === 0) {
    return 0;
  }

  return (
    pairs.reduce((sum, pair) => sum + (pair.predicted - pair.outcome) ** 2, 0) / pairs.length
  );
}

export function logLoss(pairs: Array<Pick<EvaluationPair, "predicted" | "outcome">>): number {
  if (pairs.length === 0) {
    return 0;
  }

  return (
    pairs.reduce((sum, pair) => {
      const predicted = Math.min(Math.max(pair.predicted, 1e-6), 1 - 1e-6);
      return sum - (pair.outcome * Math.log(predicted) + (1 - pair.outcome) * Math.log(1 - predicted));
    }, 0) / pairs.length
  );
}

export function averageAbsoluteError(
  pairs: Array<Pick<EvaluationPair, "predicted" | "outcome">>,
): number {
  if (pairs.length === 0) {
    return 0;
  }

  return pairs.reduce((sum, pair) => sum + Math.abs(pair.predicted - pair.outcome), 0) / pairs.length;
}

export function calibrationBins(
  pairs: Array<Pick<EvaluationPair, "predicted" | "outcome">>,
  bins = 10,
): Array<{
  sampleSize: number;
  lowerBound: number;
  upperBound: number;
  averagePredicted: number;
  averageObserved: number;
}> {
  if (pairs.length === 0) {
    return [];
  }

  const buckets = Array.from({ length: bins }, () => [] as typeof pairs);

  for (const pair of pairs) {
    const bucketIndex = Math.min(Math.floor(pair.predicted * bins), bins - 1);
    buckets[bucketIndex]?.push(pair);
  }

  return buckets.flatMap((bucket, index) => {
    if (bucket.length === 0) {
      return [];
    }

    return [
      {
        sampleSize: bucket.length,
        lowerBound: index / bins,
        upperBound: (index + 1) / bins,
        averagePredicted: bucket.reduce((sum, pair) => sum + pair.predicted, 0) / bucket.length,
        averageObserved: bucket.reduce((sum, pair) => sum + pair.outcome, 0) / bucket.length,
      },
    ];
  });
}

export function expectedCalibrationError(
  pairs: Array<Pick<EvaluationPair, "predicted" | "outcome">>,
  bins = 10,
): number {
  if (pairs.length === 0) {
    return 0;
  }

  const grouped = calibrationBins(pairs, bins);

  return grouped.reduce((sum, bucket) => {
    return (
      sum +
      (bucket.sampleSize / pairs.length) *
        Math.abs(bucket.averagePredicted - bucket.averageObserved)
    );
  }, 0);
}

export function winRateVsReference(
  pairs: Array<Pick<EvaluationPair, "predicted" | "outcome" | "referencePredicted">>,
): number {
  const comparablePairs = pairs.filter((pair) => typeof pair.referencePredicted === "number");

  if (comparablePairs.length === 0) {
    return 0;
  }

  const wins = comparablePairs.filter((pair) => {
    const ourError = Math.abs(pair.predicted - pair.outcome);
    const referenceError = Math.abs((pair.referencePredicted as number) - pair.outcome);
    return ourError < referenceError;
  }).length;

  return wins / comparablePairs.length;
}

/** A small seeded generator, so a run's interval is the same every time it is computed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ClusteredDifference {
  /** Mean Brier score minus the reference's, over every forecast. Above zero is worse. */
  mean: number;
  low: number;
  high: number;
  groups: number;
}

/**
 * How much worse (or better) these forecasts score than the reference forecasts on the
 * same questions, with a 95% interval from resampling whole groups.
 *
 * A market forecast at several horizons gives several correlated forecasts, so the unit
 * that is resampled is the market: treating forecasts as independent would make the
 * interval too narrow. Returns null when there are fewer than two groups to resample.
 */
export function clusteredBrierDifference(
  pairs: Array<{ groupId: string; predicted: number; outcome: number; referencePredicted?: number }>,
  options: { resamples?: number; seed?: number } = {},
): ClusteredDifference | null {
  const byGroup = new Map<string, { sum: number; count: number }>();

  for (const pair of pairs) {
    if (typeof pair.referencePredicted !== "number") {
      continue;
    }

    const difference = (pair.predicted - pair.outcome) ** 2 - (pair.referencePredicted - pair.outcome) ** 2;
    const group = byGroup.get(pair.groupId) ?? { sum: 0, count: 0 };
    group.sum += difference;
    group.count += 1;
    byGroup.set(pair.groupId, group);
  }

  const groups = [...byGroup.values()];

  if (groups.length < 2) {
    return null;
  }

  const meanOf = (sample: Array<{ sum: number; count: number }>) =>
    sample.reduce((total, group) => total + group.sum, 0) /
    sample.reduce((total, group) => total + group.count, 0);
  const random = seededRandom(options.seed ?? 7);
  const resamples = options.resamples ?? 1000;
  const means = Array.from({ length: resamples }, () =>
    meanOf(Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]!)),
  ).sort((left, right) => left - right);

  return {
    mean: meanOf(groups),
    low: means[Math.floor(0.025 * (resamples - 1))]!,
    high: means[Math.ceil(0.975 * (resamples - 1))]!,
    groups: groups.length,
  };
}

export function sliceMetrics(
  pairs: EvaluationPair[],
  options: {
    key: "theme" | "horizon" | "sourceConfiguration";
    baseline: EvaluationSliceResult["baseline"];
  },
): EvaluationSliceResult[] {
  const filtered = pairs.filter((pair) => pair.baseline === options.baseline);
  const grouped = new Map<string, EvaluationPair[]>();

  for (const pair of filtered) {
    const sliceKey = pair[options.key];

    if (!sliceKey) {
      continue;
    }

    const bucket = grouped.get(sliceKey) ?? [];
    bucket.push(pair);
    grouped.set(sliceKey, bucket);
  }

  return [...grouped.entries()]
    .map(([sliceKey, bucket]) => ({
      sliceKey,
      baseline: options.baseline,
      brierScore: brierScore(bucket),
      logLoss: logLoss(bucket),
      averageAbsoluteError: averageAbsoluteError(bucket),
      winRateVsPolymarket: winRateVsReference(bucket),
      sampleSize: bucket.length,
    }))
    .sort((left, right) => left.sliceKey.localeCompare(right.sliceKey));
}
