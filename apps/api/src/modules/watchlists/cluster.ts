import { createHash } from "node:crypto";

import type { EvidenceItem } from "@cassandra/shared";

export interface CandidateSignature {
  version: 1;
  entities: string[];
  action: string;
  objectTokens: string[];
  polarity: "positive" | "negative" | "neutral";
}

export interface CandidateCluster {
  title: string;
  description: string;
  clusterKey: string;
  candidateSignature: CandidateSignature;
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
  prepare: "launch",
  prepared: "launch",
  prepares: "launch",
  preparing: "launch",
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

function normalizeEntity(value: string): string {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function selectPrimaryAction(profile: EvidenceProfile): string {
  const preferredActions = ["reject", "delay", "approve", "launch", "announce"];

  for (const action of preferredActions) {
    if (profile.actionLabels.has(action)) {
      return action;
    }
  }

  return profile.actionLabels.values().next().value ?? "unknown";
}

export function extractCandidateSignature(item: EvidenceItem): CandidateSignature {
  const profile = buildEvidenceProfile([item]);
  const normalizedEntities = sortUnique(item.entities.map(normalizeEntity));
  const primaryAction = selectPrimaryAction(profile);
  const entityTokens = new Set(profile.entityTokens);
  const objectTokens = sortUnique(
    profile.combinedTokens.filter(
      (token) => !entityTokens.has(token) && !profile.actionLabels.has(token),
    ),
  ).slice(0, 6);
  const polarity =
    item.stance === "contradicts" || NEGATIVE_ACTIONS.has(primaryAction)
      ? "negative"
      : item.stance === "neutral" || item.stance === "unknown"
        ? "neutral"
        : "positive";

  return {
    version: 1,
    entities: normalizedEntities,
    action: primaryAction,
    objectTokens,
    polarity,
  };
}

export function buildCandidateSignatureKey(signature: CandidateSignature): string {
  const payload = JSON.stringify({
    version: signature.version,
    entities: signature.entities,
    action: signature.action,
    polarity: signature.polarity,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

export function clusterCandidateEvidence(items: EvidenceItem[]): CandidateCluster[] {
  const clustersByKey = new Map<string, CandidateCluster>();

  for (const item of items) {
    const signature = extractCandidateSignature(item);
    const clusterKey = buildCandidateSignatureKey(signature);
    const existingCluster = clustersByKey.get(clusterKey);

    if (!existingCluster) {
      const profile = buildEvidenceProfile([item]);

      clustersByKey.set(clusterKey, {
        title: item.title,
        description: item.summary,
        clusterKey,
        candidateSignature: signature,
        supportingEvidenceIds: [item.id],
        evidence: [item],
      });
      continue;
    }

    existingCluster.supportingEvidenceIds = [...existingCluster.supportingEvidenceIds, item.id];
    existingCluster.evidence = [...existingCluster.evidence, item];

    if (item.summary.length > existingCluster.description.length) {
      existingCluster.description = item.summary;
    }

    if (item.title.length > existingCluster.title.length) {
      existingCluster.title = item.title;
    }
  }

  return [...clustersByKey.values()].sort(
    (left, right) =>
      right.supportingEvidenceIds.length - left.supportingEvidenceIds.length ||
      left.title.localeCompare(right.title),
  );
}
