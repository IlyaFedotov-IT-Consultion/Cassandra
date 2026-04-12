import type { JudgeOpinion, VerdictTrace } from "@cassandra/shared";

export function probabilityToLogOdds(p: number): number {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

export function logOddsToProbability(logOdds: number): number {
  return 1 / (1 + Math.exp(-logOdds));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function variance(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const mean = average(values);
  return average(values.map((value) => (value - mean) ** 2));
}

export function computeFreshnessDecay(publishedAt: string, evaluationTime: string): number {
  const ageHours = Math.max(
    0,
    (new Date(evaluationTime).getTime() - new Date(publishedAt).getTime()) / (1000 * 60 * 60),
  );

  return clamp(Math.exp(-ageHours / 168), 0.2, 1);
}

export function computeJaccardOverlap(leftIds: string[], rightIds: string[]): number {
  const leftSet = new Set(leftIds);
  const rightSet = new Set(rightIds);
  const union = new Set([...leftSet, ...rightSet]);
  const intersectionCount = [...leftSet].filter((id) => rightSet.has(id)).length;
  return union.size === 0 ? 0 : intersectionCount / union.size;
}

export function buildDependencyMatrix(judgeOpinions: JudgeOpinion[]): VerdictTrace["dependencyMatrix"] {
  const entries: VerdictTrace["dependencyMatrix"] = [];

  for (let i = 0; i < judgeOpinions.length; i += 1) {
    const left = judgeOpinions[i];

    if (!left) {
      continue;
    }

    for (let j = i + 1; j < judgeOpinions.length; j += 1) {
      const right = judgeOpinions[j];

      if (!right) {
        continue;
      }

      const jaccard = computeJaccardOverlap(left.evidenceIds, right.evidenceIds);
      entries.push({ judgeA: left.judgeName, judgeB: right.judgeName, jaccard });
    }
  }

  return entries;
}

export function computeDependencyDiscount(
  judgeName: string,
  allOpinions: Array<{ judgeName: string; evidenceIds: string[] }>,
): number {
  const self = allOpinions.find((o) => o.judgeName === judgeName);

  if (!self || self.evidenceIds.length === 0) {
    return 1;
  }

  let overlapSum = 0;

  for (const other of allOpinions) {
    if (other.judgeName === judgeName) {
      continue;
    }

    overlapSum += computeJaccardOverlap(self.evidenceIds, other.evidenceIds);
  }

  return 1 / (1 + overlapSum);
}

export function computeDisagreementShrinkage(logBayesFactors: number[]): number {
  return clamp(variance(logBayesFactors) * 0.25, 0, 0.6);
}

export function computePosteriorWithShrinkage(args: {
  rawPosteriorLogOdds: number;
  priorLogOdds: number;
  shrinkage: number;
}): number {
  const posteriorLogOdds =
    (1 - args.shrinkage) * args.rawPosteriorLogOdds +
    args.shrinkage * args.priorLogOdds;
  return logOddsToProbability(posteriorLogOdds);
}
