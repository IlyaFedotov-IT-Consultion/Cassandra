import type { EvidenceItem } from "@cassandra/shared";

export interface CandidateCluster {
  title: string;
  description: string;
  clusterKey: string;
  supportingEvidenceIds: string[];
  evidence: EvidenceItem[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "in",
  "is",
  "of",
  "on",
  "prepares",
  "preparing",
  "reports",
  "say",
  "the",
  "to",
  "will",
]);

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function jaccardSimilarity(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);

  if (union.size === 0) {
    return 0;
  }

  let intersectionSize = 0;

  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersectionSize += 1;
    }
  }

  return intersectionSize / union.size;
}

function buildClusterKey(tokens: string[]): string {
  return [...new Set(tokens)].sort().join("-");
}

export function clusterCandidateEvidence(items: EvidenceItem[]): CandidateCluster[] {
  const clusters: CandidateCluster[] = [];

  for (const item of items) {
    const titleTokens = tokenize(item.title);
    const claimTokens = tokenize(item.claims.join(" "));
    const evidenceTokens = [...titleTokens, ...claimTokens];
    let matchedCluster: CandidateCluster | undefined;

    for (const cluster of clusters) {
      const clusterTokens = tokenize(`${cluster.title} ${cluster.description}`);

      if (jaccardSimilarity(evidenceTokens, clusterTokens) >= 0.4) {
        matchedCluster = cluster;
        break;
      }
    }

    if (!matchedCluster) {
      clusters.push({
        title: item.title,
        description: item.summary,
        clusterKey: buildClusterKey(evidenceTokens),
        supportingEvidenceIds: [item.id],
        evidence: [item],
      });
      continue;
    }

    matchedCluster.supportingEvidenceIds = [...matchedCluster.supportingEvidenceIds, item.id];
    matchedCluster.evidence = [...matchedCluster.evidence, item];

    if (item.summary.length > matchedCluster.description.length) {
      matchedCluster.description = item.summary;
    }

    if (item.title.length > matchedCluster.title.length) {
      matchedCluster.title = item.title;
    }
  }

  return clusters.sort(
    (left, right) =>
      right.supportingEvidenceIds.length - left.supportingEvidenceIds.length ||
      left.title.localeCompare(right.title),
  );
}
