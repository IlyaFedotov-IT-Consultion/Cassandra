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
