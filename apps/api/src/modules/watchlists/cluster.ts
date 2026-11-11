import { createHash } from "node:crypto";

import type { EvidenceItem } from "@cassandra/shared";

export interface CandidateSignature {
  version: 1;
  entities: string[];
  action: string;
  objectTokens: string[];
  polarity: "positive" | "negative" | "neutral";
  /**
   * Headline words that identify the story, set when the item had no entities of its own
   * to identify it. Later runs match new headlines against it.
   */
  topic?: string[];
}

export interface ClusterOptions {
  /**
   * Entities every item of this run shares, such as the watchlist's keywords. They say
   * nothing about which story an item belongs to, so items that carry only these are
   * grouped by headline instead.
   */
  genericEntities?: string[];
  /** Candidates stored by earlier runs, so a story found again keeps its candidate. */
  existing?: Array<{ clusterKey: string; candidateSignature: CandidateSignature | null }>;
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
const ACTION_LABELS = new Set(["launch", "approve", "delay", "reject", "announce"]);

/** Words too common in headlines to say which story a headline is about. */
const TOPIC_STOP_WORDS = new Set([
  "about", "after", "amid", "are", "as", "at", "be", "from", "has", "have", "into", "it", "its",
  "new", "over", "said", "says", "than", "that", "this", "was", "with",
]);
// Two headlines are one story when most of the shorter one's words appear in the other.
const MIN_TOPIC_OVERLAP = 0.6;
const MIN_SHARED_TOPIC_TOKENS = 2;
const MAX_TOPIC_TOKENS = 12;

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
  const actionLabels = new Set(
    combinedTokens.filter((token) => token in ACTION_SYNONYMS || ACTION_LABELS.has(token)),
  );

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

/**
 * Two headlines are one story when most of the shorter one's words appear in the other and
 * at least two of the shared words are distinctive. Words every item of the run shares (the
 * watchlist's keywords) count toward the overlap but cannot establish it on their own:
 * otherwise "Fed cuts rates" and "Fed raises rate forecast" would be one story.
 */
function isSameStory(left: string[], right: string[], genericTokens: Set<string>): boolean {
  const rightSet = new Set(right);
  const sharedDistinctive = [...new Set(left)].filter(
    (token) => rightSet.has(token) && !genericTokens.has(token),
  ).length;

  return sharedDistinctive >= MIN_SHARED_TOPIC_TOKENS && overlapRatio(left, right) >= MIN_TOPIC_OVERLAP;
}

/** The headline words that identify an item's story: no filler and no action words. */
function topicTokens(item: EvidenceItem): string[] {
  const titleTokens = sortUnique(tokenize(item.title));
  const topic = titleTokens.filter((token) => !TOPIC_STOP_WORDS.has(token) && !ACTION_LABELS.has(token));

  return (topic.length > 0 ? topic : titleTokens).slice(0, MAX_TOPIC_TOKENS);
}

function buildTopicKey(signature: CandidateSignature, topic: string[]): string {
  const payload = JSON.stringify({
    version: signature.version,
    entities: signature.entities,
    action: signature.action,
    polarity: signature.polarity,
    topic,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

function sameFrame(left: CandidateSignature, right: CandidateSignature): boolean {
  return (
    left.action === right.action &&
    left.polarity === right.polarity &&
    left.entities.join("|") === right.entities.join("|")
  );
}

/**
 * Groups evidence into candidate events.
 *
 * An item with entities of its own is identified by them: who did what, with which
 * polarity. An item without any, which is what a live search result is, is identified by
 * its headline instead: it joins a candidate whose headline shares most of its words.
 * Without this, every entity-less item with the same action word would be one candidate.
 */
export function clusterCandidateEvidence(
  items: EvidenceItem[],
  options: ClusterOptions = {},
): CandidateCluster[] {
  const clustersByKey = new Map<string, CandidateCluster>();
  const genericEntities = new Set((options.genericEntities ?? []).map(normalizeEntity));
  const genericTokens = new Set(tokenize([...genericEntities].join(" ")));
  const storedTopics = (options.existing ?? []).flatMap((candidate) =>
    candidate.candidateSignature?.topic
      ? [{ clusterKey: candidate.clusterKey, signature: candidate.candidateSignature, topic: candidate.candidateSignature.topic }]
      : [],
  );

  const resolve = (item: EvidenceItem): { clusterKey: string; signature: CandidateSignature } => {
    const signature = extractCandidateSignature(item);

    if (signature.entities.some((entity) => !genericEntities.has(entity))) {
      return { clusterKey: buildCandidateSignatureKey(signature), signature };
    }

    const topic = topicTokens(item);
    const sameStory = (candidate: { signature: CandidateSignature; topic: string[] }) =>
      sameFrame(candidate.signature, signature) && isSameStory(candidate.topic, topic, genericTokens);
    const inThisRun = [...clustersByKey.values()]
      .flatMap((cluster) =>
        cluster.candidateSignature.topic
          ? [{ clusterKey: cluster.clusterKey, signature: cluster.candidateSignature, topic: cluster.candidateSignature.topic }]
          : [],
      )
      .find(sameStory);
    const known = inThisRun ?? storedTopics.find(sameStory);

    // A story keeps the topic it was first stored with, so its key stays put as wording drifts.
    return known
      ? { clusterKey: known.clusterKey, signature: { ...signature, topic: known.topic } }
      : { clusterKey: buildTopicKey(signature, topic), signature: { ...signature, topic } };
  };

  for (const item of items) {
    const { clusterKey, signature } = resolve(item);
    const existingCluster = clustersByKey.get(clusterKey);

    if (!existingCluster) {
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
