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

const ACTION_SYNONYMS: Record<string, string> = {
  announced: "announce",
  announces: "announce",
  announcing: "announce",
  approval: "approve",
  approve: "approve",
  approved: "approve",
  approves: "approve",
  clear: "approve",
  cleared: "approve",
  clears: "approve",
  debuts: "launch",
  debut: "launch",
  debuted: "launch",
  debuting: "launch",
  defer: "delay",
  deferred: "delay",
  defers: "delay",
  delayed: "delay",
  delaying: "delay",
  delays: "delay",
  deny: "reject",
  denies: "reject",
  denied: "reject",
  denial: "reject",
  launch: "launch",
  launched: "launch",
  launches: "launch",
  launching: "launch",
  postpone: "delay",
  postponed: "delay",
  postpones: "delay",
  release: "launch",
  released: "launch",
  releases: "launch",
  releasing: "launch",
  reject: "reject",
  rejected: "reject",
  rejects: "reject",
  rejection: "reject",
  rollout: "launch",
  rollouts: "launch",
  slipped: "delay",
  slips: "delay",
};

const NEGATIVE_ACTIONS = new Set(["delay", "reject"]);

interface EvidenceProfile {
  actionLabels: Set<string>;
  entityTokens: string[];
  titleTokens: string[];
  claimTokens: string[];
  combinedTokens: string[];
  negativeAction: boolean;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeToken(token: string): string {
  const direct = ACTION_SYNONYMS[token];

  if (direct) {
    return direct;
  }

  if (token.endsWith("ing") && token.length > 5) {
    return normalizeToken(token.slice(0, -3));
  }

  if (token.endsWith("ed") && token.length > 4) {
    return normalizeToken(token.slice(0, -2));
  }

  if (token.endsWith("es") && token.length > 4) {
    return normalizeToken(token.slice(0, -2));
  }

  if (token.endsWith("s") && token.length > 3) {
    return normalizeToken(token.slice(0, -1));
  }

  return token;
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .map(normalizeToken)
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

function overlapRatio(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const smaller = Math.min(leftSet.size, rightSet.size);

  if (smaller === 0) {
    return 0;
  }

  let overlap = 0;

  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }

  return overlap / smaller;
}

function buildEvidenceProfile(items: EvidenceItem[]): EvidenceProfile {
  const entityTokens = tokenize(items.flatMap((item) => item.entities).join(" "));
  const titleTokens = tokenize(items.map((item) => item.title).join(" "));
  const claimTokens = tokenize(items.flatMap((item) => item.claims).join(" "));
  const combinedTokens = tokenize(
    items
      .map((item) => `${item.title} ${item.summary} ${item.claims.join(" ")} ${item.entities.join(" ")}`)
      .join(" "),
  );
  const actionLabels = new Set(combinedTokens.filter((token) => token in ACTION_SYNONYMS || token === "launch" || token === "approve" || token === "delay" || token === "reject" || token === "announce"));

  return {
    actionLabels,
    entityTokens,
    titleTokens,
    claimTokens,
    combinedTokens,
    negativeAction: [...actionLabels].some((token) => NEGATIVE_ACTIONS.has(token)),
  };
}

function shouldCluster(profile: EvidenceProfile, clusterProfile: EvidenceProfile): boolean {
  const entityScore =
    profile.entityTokens.length > 0 && clusterProfile.entityTokens.length > 0
      ? overlapRatio(profile.entityTokens, clusterProfile.entityTokens)
      : 0;
  const titleScore = jaccardSimilarity(profile.titleTokens, clusterProfile.titleTokens);
  const claimScore = jaccardSimilarity(profile.claimTokens, clusterProfile.claimTokens);
  const combinedScore = jaccardSimilarity(profile.combinedTokens, clusterProfile.combinedTokens);

  if (entityScore > 0 && entityScore < 0.5) {
    return false;
  }

  if (profile.negativeAction !== clusterProfile.negativeAction) {
    return false;
  }

  if (profile.actionLabels.size > 0 && clusterProfile.actionLabels.size > 0) {
    const actionOverlap = [...profile.actionLabels].some((label) =>
      clusterProfile.actionLabels.has(label),
    );

    if (!actionOverlap) {
      return false;
    }
  }

  const weightedScore =
    entityScore * 0.4 + Math.max(titleScore, claimScore) * 0.35 + combinedScore * 0.25;

  return weightedScore >= 0.45;
}

export function clusterCandidateEvidence(items: EvidenceItem[]): CandidateCluster[] {
  const clusters: CandidateCluster[] = [];

  for (const item of items) {
    const profile = buildEvidenceProfile([item]);
    let matchedCluster: CandidateCluster | undefined;

    for (const cluster of clusters) {
      const clusterProfile = buildEvidenceProfile(cluster.evidence);

      if (shouldCluster(profile, clusterProfile)) {
        matchedCluster = cluster;
        break;
      }
    }

    if (!matchedCluster) {
      clusters.push({
        title: item.title,
        description: item.summary,
        clusterKey: buildClusterKey([
          ...profile.entityTokens,
          ...profile.actionLabels,
          ...profile.claimTokens.slice(0, 6),
        ]),
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
