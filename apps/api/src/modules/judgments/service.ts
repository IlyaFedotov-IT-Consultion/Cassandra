import { randomUUID } from "node:crypto";

import {
  type EvidenceItem,
  type JudgmentExecutionLogEntry,
  type RuntimeEventRecord,
  VerdictTraceSchema,
  type CalibrationSnapshot,
  type JudgeOpinion,
  type VerdictTrace,
} from "@cassandra/shared";
import type { Redis } from "ioredis";
import type { Pool } from "pg";

import type { AppEnv } from "../../config/env.js";
import type { AppLogger } from "../../lib/logger.js";
import {
  InMemoryEvidenceCacheStore,
  collectEvidenceForEventWithCache,
  createRedisEvidenceCacheStore,
  type EvidenceCacheStore,
} from "../evidence/cache.js";
import { createCommunitySearchProvider } from "../evidence/providers/communitySearch.js";
import { createGovernmentSearchProvider } from "../evidence/providers/governmentSearch.js";
import { createMarketProvider } from "../evidence/providers/marketProvider.js";
import { createOfficialSearchProvider } from "../evidence/providers/officialSearch.js";
import { createPerplexityProvider } from "../evidence/providers/perplexity.js";
import { createPolymarketClobProvider } from "../evidence/providers/polymarketClob.js";
import { createPolymarketGammaProvider } from "../evidence/providers/polymarketGamma.js";
import { createWebProvider } from "../evidence/providers/web.js";
import type { AdapterMode, EvidenceProvider } from "../evidence/types.js";
import { getEventById, type EventRecord } from "../events/repository.js";
import { countOutcomes } from "../outcomes/repository.js";
import {
  getLatestCalibrationSnapshot,
  retrainCalibrationSnapshot,
} from "../backtests/repository.js";
import {
  InMemoryJudgeCacheStore,
  createRedisJudgeCacheStore,
  getOrCreateCachedJudgeResult,
  type JudgeCacheStore,
} from "./judgeCache.js";
import {
  appendJudgmentExecutionLog,
  appendJudgmentTrace,
  createJudgmentRun,
  getJudgmentById,
  listJudgeOpinionsForJudgment,
  listJudgments,
  type JudgmentRecord,
  updateJudgmentStatus,
} from "./repository.js";

const DEFAULT_EVALUATION_TIME = () => new Date().toISOString();
const PROMPT_VERSION = "prompt-v1";
const MIN_COMPLETED_LIVE_CITATIONS = 2;
const MAX_EVIDENCE_ITEMS_FOR_JUDGE = 12;
const MAX_EVIDENCE_ITEMS_PER_FAMILY = 4;
const CITATION_RELEVANCE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
]);
export const LIVE_AUTHORITATIVE_SEARCH_PROVIDER_REQUIRED_MESSAGE =
  "Live judgments require at least one configured authoritative search provider. Set ZAI_API_KEY or PERPLEXITY_API_KEY, or switch to CASSANDRA_ADAPTER_MODE=fixture.";
const PANEL_JUDGES = [
  {
    judgeName: "official_records",
    sourceFamilies: ["official", "government"] as const,
    missingSourceFamily: "official",
  },
  {
    judgeName: "community_signal",
    sourceFamilies: ["community"] as const,
    missingSourceFamily: "community",
  },
  {
    judgeName: "open_web_research",
    sourceFamilies: ["web", "llm_research", "market", "prediction_market"] as const,
    missingSourceFamily: "web",
  },
] as const;

const EVIDENCE_STRENGTH_TO_LOG_BF: Record<JudgeOpinion["evidenceStrength"], number> = {
  strong_against: -3,
  moderate_against: -1.5,
  weak_against: -0.5,
  neutral: 0,
  weak_for: 0.5,
  moderate_for: 1.5,
  strong_for: 3,
};

type CitationRecord = VerdictTrace["citations"][number];
type SourceFamily = CitationRecord["sourceFamily"];
type ConflictRecord = VerdictTrace["conflicts"][number];
type MissingEvidenceRecord = VerdictTrace["missingEvidence"][number];
type CacheTraceRecord = VerdictTrace["cacheEvents"][number];
type JudgmentExecutionStage = JudgmentExecutionLogEntry["stage"];

export interface JudgmentRecordDetails extends JudgmentRecord {
  judgeOpinions: JudgeOpinion[];
}

export interface ListRuntimeEventsFilters {
  search?: string;
  judgmentStatus?: JudgmentRecord["status"];
  stage?: JudgmentExecutionLogEntry["stage"];
  level?: JudgmentExecutionLogEntry["level"];
  limit?: number;
}

export interface JudgeClient {
  judge(input: {
    event: EventRecord;
    evaluationTime: string;
    evidence: JudgmentEvidenceItem[];
    calibrationSnapshot: CalibrationSnapshot;
    mode: AdapterMode;
  }): Promise<VerdictTrace>;
}

interface JudgmentEvidenceItem {
  id: string;
  eventId?: string;
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
  sourceFamily: SourceFamily;
  sourceType: string;
  publisher: string;
  retrievedAt: string;
  rawText: string | null;
  entities: string[];
  claims: string[];
  stance: "supports" | "contradicts" | "neutral" | "unknown";
  qualitySignals: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

function mapEvidenceForJudge(evidence: EvidenceItem[]): JudgmentEvidenceItem[] {
  return evidence.map((item) => ({
    id: item.id,
    eventId: item.eventId,
    title: item.title,
    url: item.url,
    summary: item.summary,
    publishedAt: item.publishedAt,
    sourceFamily: item.sourceFamily,
    sourceType: item.sourceType,
    publisher: item.publisher,
    retrievedAt: item.retrievedAt,
    rawText: item.rawText,
    entities: item.entities,
    claims: item.claims,
    stance: item.stance,
    qualitySignals: item.qualitySignals,
    metadata: item.metadata,
  }));
}

function buildJudgmentExecutionLogEntry(args: {
  stage: JudgmentExecutionStage;
  message: string;
  level?: JudgmentExecutionLogEntry["level"];
  details?: Record<string, unknown>;
}): JudgmentExecutionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    stage: args.stage,
    level: args.level ?? "info",
    message: args.message,
    details: args.details ?? {},
  };
}

async function recordJudgmentExecutionLog(args: {
  pool: Pool;
  judgmentId: string;
  logger?: AppLogger;
  entry: JudgmentExecutionLogEntry;
}): Promise<void> {
  await appendJudgmentExecutionLog(args.pool, args.judgmentId, args.entry);

  const payload = {
    event: "judgment_execution_log",
    stage: args.entry.stage,
    level: args.entry.level,
    timestamp: args.entry.timestamp,
    details: args.entry.details,
  };

  if (args.entry.level === "error") {
    args.logger?.error(payload, args.entry.message);
    return;
  }

  if (args.entry.level === "warn") {
    args.logger?.warn(payload, args.entry.message);
    return;
  }

  args.logger?.info(payload, args.entry.message);
}

export interface JudgmentServiceDeps {
  pool: Pool;
  env: AppEnv;
  evidenceProviders?: EvidenceProvider[];
  evidenceCacheStore?: EvidenceCacheStore;
  judgeCacheStore?: JudgeCacheStore;
  judgeClient?: JudgeClient;
  logger?: AppLogger;
}

export interface CreateJudgmentInput {
  eventId: string;
  evaluationTime?: string;
}

export interface RunJudgmentInput extends CreateJudgmentInput {
  judgmentId: string;
}

export interface EvaluateEventForecastArgs {
  env: AppEnv;
  event: EventRecord;
  evaluationTime: string;
  evidence: EvidenceItem[];
  calibrationSnapshot: CalibrationSnapshot;
  judgeCacheStore?: JudgeCacheStore;
  judgeClient?: JudgeClient;
}

interface LiveCoverageResult {
  uniqueCitationCount: number;
  hasEnoughCitationCoverage: boolean;
  missingEvidence: MissingEvidenceRecord[];
}

function buildJudgeModelVersion(env: AppEnv): string {
  return [
    env.CASSANDRA_ADAPTER_MODE,
    env.OPENROUTER_JUDGE_MODEL ?? "default-judge",
    env.OPENROUTER_CROSS_EXAMINER_MODEL ?? "default-cross",
    env.OPENROUTER_SEARCH_MODEL ?? "default-search",
    env.ZAI_MODEL ?? "default-zai",
  ].join("|");
}

function buildEvidenceFingerprint(evidence: JudgmentEvidenceItem[]): string {
  return evidence
    .map((item) =>
      [
        item.id,
        item.url.trim().toLowerCase(),
        item.sourceFamily,
        item.sourceType,
        item.publishedAt,
      ].join("|"),
    )
    .sort()
    .join("||");
}

function isPlaceholderCitationUrl(url: string): boolean {
  return (
    url.includes("example.invalid") ||
    url.includes("openrouter.ai/synthetic")
  );
}

function assessLiveCoverage(
  event: EventRecord,
  evidence: JudgmentEvidenceItem[],
): LiveCoverageResult {
  const uniqueCitationUrls = new Set(
    evidence
      .map((item) => item.url)
      .filter((url) => !isPlaceholderCitationUrl(url)),
  );
  const hasAuthoritativeCitation = evidence.some((item) => {
    return (
      ["official", "government", "community", "web"].includes(item.sourceFamily) &&
      !isPlaceholderCitationUrl(item.url)
    );
  });

  return {
    uniqueCitationCount: uniqueCitationUrls.size,
    hasEnoughCitationCoverage:
      uniqueCitationUrls.size >= MIN_COMPLETED_LIVE_CITATIONS &&
      hasAuthoritativeCitation,
    missingEvidence: buildMissingEvidence(event, evidence),
  };
}

export function assessLiveCoverageForEvidence(
  event: EventRecord,
  evidence: EvidenceItem[],
): LiveCoverageResult {
  return assessLiveCoverage(event, mapEvidenceForJudge(evidence));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function probabilityToLogOdds(probability: number): number {
  const bounded = clamp(probability, 1e-6, 1 - 1e-6);
  return Math.log(bounded / (1 - bounded));
}

function logOddsToProbability(logOdds: number): number {
  return 1 / (1 + Math.exp(-logOdds));
}

function selectCalibrationMethod(snapshot: CalibrationSnapshot): VerdictTrace["calibrationMethod"] {
  const method = snapshot.calibrationParams.method;

  if (
    method === "identity" ||
    method === "isotonic" ||
    method === "logistic" ||
    method === "beta"
  ) {
    return method;
  }

  return snapshot.weightRegime === "steady"
    ? "isotonic"
    : snapshot.weightRegime === "warming"
      ? "logistic"
      : "identity";
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const mean = average(values);
  return average(values.map((value) => (value - mean) ** 2));
}

function mapEvidenceStrength(score: number): JudgeOpinion["evidenceStrength"] {
  if (score >= 2.5) {
    return "strong_for";
  }

  if (score >= 1.5) {
    return "moderate_for";
  }

  if (score >= 0.5) {
    return "weak_for";
  }

  if (score <= -2.5) {
    return "strong_against";
  }

  if (score <= -1.5) {
    return "moderate_against";
  }

  if (score <= -0.5) {
    return "weak_against";
  }

  return "neutral";
}

function stanceToScore(stance: JudgmentEvidenceItem["stance"]): number {
  switch (stance) {
    case "supports":
      return 1;
    case "contradicts":
      return -1;
    case "neutral":
    case "unknown":
      return 0;
  }
}

function computeFreshnessDecay(publishedAt: string, evaluationTime: string): number {
  const ageHours = Math.max(
    0,
    (new Date(evaluationTime).getTime() - new Date(publishedAt).getTime()) / (1000 * 60 * 60),
  );

  return clamp(Math.exp(-ageHours / 168), 0.2, 1);
}

function buildDependencyMatrix(judgeOpinions: JudgeOpinion[]): VerdictTrace["dependencyMatrix"] {
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

      const leftIds = new Set(left.evidenceIds);
      const rightIds = new Set(right.evidenceIds);
      const union = new Set([...leftIds, ...rightIds]);
      const intersectionCount = [...leftIds].filter((id) => rightIds.has(id)).length;
      const jaccard = union.size === 0 ? 0 : intersectionCount / union.size;

      entries.push({
        judgeA: left.judgeName,
        judgeB: right.judgeName,
        jaccard,
      });
    }
  }

  return entries;
}

function buildConflicts(judgeOpinions: JudgeOpinion[]): ConflictRecord[] {
  const conflicts: ConflictRecord[] = [];

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

      const probabilityGap = Math.abs(left.probability - right.probability);

      if (probabilityGap < 0.2) {
        continue;
      }

      conflicts.push({
        judgeA: left.judgeName,
        judgeB: right.judgeName,
        reason: `Probability gap of ${probabilityGap.toFixed(2)} across overlapping evidence.`,
        severity: probabilityGap >= 0.35 ? "high" : probabilityGap >= 0.25 ? "medium" : "low",
      });
    }
  }

  return conflicts;
}

function buildMissingEvidence(
  event: EventRecord,
  evidence: JudgmentEvidenceItem[],
): MissingEvidenceRecord[] {
  const availableFamilies = new Set(evidence.map((item) => item.sourceFamily));
  const missing: MissingEvidenceRecord[] = [];

  if (!availableFamilies.has("official" as SourceFamily)) {
    missing.push({
      claim: event.question,
      sourceFamily: "official" as SourceFamily,
      reason: "No official source was collected for this judgment run.",
    });
  }

  if (!availableFamilies.has("community" as SourceFamily)) {
    missing.push({
      claim: event.question,
      sourceFamily: "community" as SourceFamily,
      reason: "No community discussion source was collected for this judgment run.",
    });
  }

  if (
    !availableFamilies.has("web" as SourceFamily) &&
    !availableFamilies.has("llm_research" as SourceFamily)
  ) {
    missing.push({
      claim: event.question,
      sourceFamily: "web" as SourceFamily,
      reason: "No open-web or research source was collected for this judgment run.",
    });
  }

  return missing;
}

function buildWeightBreakdown(
  judgeOpinions: JudgeOpinion[],
  dependencyMatrix: VerdictTrace["dependencyMatrix"],
): VerdictTrace["weightBreakdown"] {
  return judgeOpinions.map((opinion) => ({
    source: opinion.judgeName,
    weight: opinion.baseWeight,
    details: {
      dependencyDiscount: opinion.dependencyDiscount,
      freshnessDecay: opinion.freshnessDecay,
      effectiveLogOddsContribution: opinion.effectiveLogOddsContribution,
      overlapCount: dependencyMatrix.filter((entry) => {
        return entry.judgeA === opinion.judgeName || entry.judgeB === opinion.judgeName;
      }).length,
    },
  }));
}

function tokenizeCitationRelevance(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 3 && !CITATION_RELEVANCE_STOP_WORDS.has(token),
  );
}

function isEventRelevantEvidence(event: EventRecord, item: JudgmentEvidenceItem): boolean {
  const evidenceText = [
    item.title,
    item.summary,
    ...item.entities,
    ...item.claims,
  ]
    .join(" ")
    .toLowerCase();
  const entityMatches = event.entities.filter((entity) => {
    const normalized = entity.trim().toLowerCase();
    return normalized.length >= 3 && evidenceText.includes(normalized);
  });

  if (entityMatches.length > 0) {
    return true;
  }

  const eventTokens = new Set(
    tokenizeCitationRelevance(
      [event.question, event.resolutionCriteria, ...event.entities].join(" "),
    ),
  );
  const evidenceTokens = new Set(tokenizeCitationRelevance(evidenceText));
  let overlapCount = 0;

  for (const token of eventTokens) {
    if (evidenceTokens.has(token)) {
      overlapCount += 1;
    }
  }

  return overlapCount >= 2;
}

function evidenceFamilyPriority(sourceFamily: SourceFamily): number {
  switch (sourceFamily) {
    case "official":
    case "government":
      return 0;
    case "community":
      return 1;
    case "web":
    case "llm_research":
      return 2;
    case "market":
    case "prediction_market":
      return 3;
    default:
      return 4;
  }
}

function compareEvidenceForJudging(left: JudgmentEvidenceItem, right: JudgmentEvidenceItem): number {
  const familyGap =
    evidenceFamilyPriority(left.sourceFamily) - evidenceFamilyPriority(right.sourceFamily);

  if (familyGap !== 0) {
    return familyGap;
  }

  const publishedGap =
    new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime();

  if (publishedGap !== 0) {
    return publishedGap;
  }

  return left.id.localeCompare(right.id);
}

function selectEvidenceForJudgeInput(
  event: EventRecord,
  evidence: JudgmentEvidenceItem[],
): JudgmentEvidenceItem[] {
  const relevantEvidence = evidence.filter((item) => isEventRelevantEvidence(event, item));
  const candidateEvidence = relevantEvidence.length > 0 ? relevantEvidence : evidence;
  const sortedEvidence = [...candidateEvidence].sort(compareEvidenceForJudging);
  const perFamilyCount = new Map<SourceFamily, number>();
  const selectedEvidence: JudgmentEvidenceItem[] = [];

  for (const item of sortedEvidence) {
    const familyCount = perFamilyCount.get(item.sourceFamily) ?? 0;

    if (familyCount >= MAX_EVIDENCE_ITEMS_PER_FAMILY) {
      continue;
    }

    selectedEvidence.push(item);
    perFamilyCount.set(item.sourceFamily, familyCount + 1);

    if (selectedEvidence.length >= MAX_EVIDENCE_ITEMS_FOR_JUDGE) {
      break;
    }
  }

  return selectedEvidence;
}

function buildCitations(evidence: JudgmentEvidenceItem[]): CitationRecord[] {
  const seen = new Set<string>();
  const citations: CitationRecord[] = [];

  for (const item of evidence) {
    if (seen.has(item.url)) {
      continue;
    }

    seen.add(item.url);
    citations.push({
      evidenceId: item.id,
      provider:
        typeof item.metadata.provider === "string" ? item.metadata.provider : undefined,
      publishedAt: item.publishedAt,
      title: item.title,
      url: item.url,
      sourceFamily: item.sourceFamily,
    });
  }

  return citations;
}

function selectTraceCitationEvidence(args: {
  event: EventRecord;
  evidence: JudgmentEvidenceItem[];
  trace: VerdictTrace;
}): JudgmentEvidenceItem[] {
  const referencedIds = new Set(
    args.trace.judgeOpinions.flatMap((opinion) => opinion.evidenceIds),
  );
  const referencedEvidence = args.evidence.filter((item) => referencedIds.has(item.id));
  const relevantReferencedEvidence = referencedEvidence.filter((item) =>
    isEventRelevantEvidence(args.event, item),
  );

  if (relevantReferencedEvidence.length > 0) {
    return relevantReferencedEvidence;
  }

  if (referencedEvidence.length > 0) {
    return referencedEvidence;
  }

  const relevantCollectedEvidence = args.evidence.filter((item) =>
    isEventRelevantEvidence(args.event, item),
  );

  if (relevantCollectedEvidence.length > 0) {
    return relevantCollectedEvidence;
  }

  return args.evidence;
}

function sanitizeTraceCitations(args: {
  event: EventRecord;
  evidence: JudgmentEvidenceItem[];
  trace: VerdictTrace;
}): VerdictTrace {
  const citations = selectTraceCitationEvidence(args);

  if (citations.length === 0) {
    return args.trace;
  }

  return VerdictTraceSchema.parse({
    ...args.trace,
    citations: buildCitations(citations),
  });
}

function buildFallbackCitation(event: EventRecord): CitationRecord {
  return {
    title: event.question,
    url: "https://example.invalid/no-evidence",
    sourceFamily: "web",
  };
}

function buildInsufficientEvidenceVerdictTrace(args: {
  env: AppEnv;
  event: EventRecord;
  evidence: JudgmentEvidenceItem[];
  evaluationTime: string;
  calibrationSnapshot: CalibrationSnapshot;
}): VerdictTrace {
  const judgeOpinions = PANEL_JUDGES.map((panelJudge) =>
    buildJudgeOpinion({
      judgeName: panelJudge.judgeName,
      evidence: [],
      calibrationSnapshot: args.calibrationSnapshot,
      evaluationTime: args.evaluationTime,
      missingSourceFamily: panelJudge.missingSourceFamily,
    }),
  );
  const dependencyMatrix = buildDependencyMatrix(judgeOpinions);
  const citations = args.evidence.length > 0
    ? buildCitations(args.evidence)
    : [buildFallbackCitation(args.event)];

  return VerdictTraceSchema.parse({
    id: randomUUID(),
    eventId: args.event.id,
    evaluationTime: args.evaluationTime,
    referenceClass: args.event.referenceClass,
    referenceClassFallback: args.event.referenceClass ? null : "global_baseline",
    priorProbability: 0.5,
    rawPosteriorProbability: 0.5,
    finalProbability: 0.5,
    confidenceLow: 0.35,
    confidenceHigh: 0.65,
    dependencyMatrix,
    disagreementShrinkage: 0,
    judgeOpinions,
    weightBreakdown: buildWeightBreakdown(judgeOpinions, dependencyMatrix),
    ensembleMethod: "logarithmic_opinion_pool",
    calibrationMethod: selectCalibrationMethod(args.calibrationSnapshot),
    uncertaintyMethod: "bootstrap",
    weightRegime: args.calibrationSnapshot.weightRegime,
    replayFidelity: "approximate",
    conflicts: [],
    missingEvidence: buildMissingEvidence(args.event, args.evidence),
    citations,
    cacheEvents: [],
    modelVersion: buildJudgeModelVersion(args.env),
    weightVersion: args.calibrationSnapshot.id,
    calibrationVersion: args.calibrationSnapshot.id,
    status: "insufficient_evidence",
  });
}

export function buildInsufficientEvidenceVerdictTraceForEvidence(args: {
  env: AppEnv;
  event: EventRecord;
  evidence: EvidenceItem[];
  evaluationTime: string;
  calibrationSnapshot: CalibrationSnapshot;
}): VerdictTrace {
  return buildInsufficientEvidenceVerdictTrace({
    env: args.env,
    event: args.event,
    evidence: mapEvidenceForJudge(args.evidence),
    evaluationTime: args.evaluationTime,
    calibrationSnapshot: args.calibrationSnapshot,
  });
}

function appendJudgeCacheEvent(
  trace: VerdictTrace,
  cacheStatus: CacheTraceRecord["status"],
): VerdictTrace {
  return VerdictTraceSchema.parse({
    ...trace,
    cacheEvents: [
      ...(trace.cacheEvents ?? []),
      {
        layer: "judge_output",
        target: "panel",
        status: cacheStatus,
      },
    ],
  });
}

function buildJudgeOpinion(args: {
  judgeName: string;
  evidence: JudgmentEvidenceItem[];
  calibrationSnapshot: CalibrationSnapshot;
  evaluationTime: string;
  missingSourceFamily: SourceFamily;
}): JudgeOpinion {
  const evidenceScore = args.evidence.reduce((sum, item) => sum + stanceToScore(item.stance), 0);
  const evidenceStrength = mapEvidenceStrength(evidenceScore);
  const logBayesFactor = EVIDENCE_STRENGTH_TO_LOG_BF[evidenceStrength] ?? 0;
  const baseWeightValue = args.calibrationSnapshot.judgeWeights[args.judgeName];
  const baseWeight =
    typeof baseWeightValue === "number" ? baseWeightValue : 1 / PANEL_JUDGES.length;
  const dependencyDiscount = args.evidence.length > 1 ? 1 / args.evidence.length : 1;
  const freshnessDecay =
    args.evidence.length === 0
      ? 1
      : average(
          args.evidence.map((item) =>
            computeFreshnessDecay(item.publishedAt, args.evaluationTime),
          ),
        );
  const effectiveLogOddsContribution =
    logBayesFactor * baseWeight * dependencyDiscount * freshnessDecay;
  const probability = clamp(
    0.5 + effectiveLogOddsContribution * 0.18 + args.evidence.length * 0.02,
    0.05,
    0.95,
  );

  return {
    judgeName: args.judgeName,
    probability,
    confidence: clamp(0.55 + args.evidence.length * 0.08, 0.55, 0.92),
    evidenceStrength,
    rationale:
      args.evidence.length > 0
        ? `Used ${args.evidence.length} evidence item(s) to produce a ${evidenceStrength.replaceAll("_", " ")} read.`
        : "No direct evidence matched this judge's source family, so the opinion remains neutral.",
    evidenceIds: args.evidence.map((item) => item.id),
    warnings:
      args.evidence.length > 0
        ? []
        : [`No ${args.missingSourceFamily} evidence was available for ${args.judgeName}.`],
    logBayesFactor,
    baseWeight,
    dependencyDiscount,
    freshnessDecay,
    effectiveLogOddsContribution,
    missingEvidence:
      args.evidence.length > 0
        ? []
        : [`Missing ${args.missingSourceFamily} evidence for ${args.judgeName}.`],
  };
}

function buildFixtureVerdictTrace(args: {
  env: AppEnv;
  event: EventRecord;
  evidence: JudgmentEvidenceItem[];
  evaluationTime: string;
  calibrationSnapshot: CalibrationSnapshot;
}): VerdictTrace {
  const priorProbability = 0.5;
  const judgeOpinions = PANEL_JUDGES.map((panelJudge) =>
    buildJudgeOpinion({
      judgeName: panelJudge.judgeName,
      evidence: args.evidence.filter((item) => {
        return (panelJudge.sourceFamilies as readonly SourceFamily[]).includes(item.sourceFamily);
      }),
      calibrationSnapshot: args.calibrationSnapshot,
      evaluationTime: args.evaluationTime,
      missingSourceFamily: panelJudge.missingSourceFamily,
    }),
  );
  const dependencyMatrix = buildDependencyMatrix(judgeOpinions);
  const rawPosteriorLogOdds =
    probabilityToLogOdds(priorProbability) +
    judgeOpinions.reduce(
      (sum, opinion) => sum + opinion.effectiveLogOddsContribution,
      0,
    );
  const rawPosteriorProbability = logOddsToProbability(rawPosteriorLogOdds);
  const disagreementShrinkage = clamp(variance(judgeOpinions.map((opinion) => opinion.probability)) * 0.25, 0, 0.6);
  const finalProbability = logOddsToProbability(rawPosteriorLogOdds * (1 - disagreementShrinkage));
  const noEvidence = args.evidence.length === 0;
  const confidenceHalfWidth = noEvidence
    ? 0.15
    : clamp(0.08 + disagreementShrinkage * 0.2, 0.08, 0.2);
  const citations = noEvidence
    ? [buildFallbackCitation(args.event)]
    : buildCitations(args.evidence);
  const verdictTrace = {
    id: randomUUID(),
    eventId: args.event.id,
    evaluationTime: args.evaluationTime,
    referenceClass: args.event.referenceClass,
    referenceClassFallback: args.event.referenceClass ? null : "global_baseline",
    priorProbability,
    rawPosteriorProbability,
    finalProbability,
    confidenceLow: clamp(finalProbability - confidenceHalfWidth, 0, finalProbability),
    confidenceHigh: clamp(finalProbability + confidenceHalfWidth, finalProbability, 1),
    dependencyMatrix,
    disagreementShrinkage,
    judgeOpinions,
    weightBreakdown: buildWeightBreakdown(judgeOpinions, dependencyMatrix),
    ensembleMethod: "logarithmic_opinion_pool" as const,
    calibrationMethod: selectCalibrationMethod(args.calibrationSnapshot),
    uncertaintyMethod: "bootstrap" as const,
    weightRegime: args.calibrationSnapshot.weightRegime,
    replayFidelity: noEvidence ? "approximate" as const : "exact" as const,
    conflicts: buildConflicts(judgeOpinions),
    missingEvidence: buildMissingEvidence(args.event, args.evidence),
    citations,
    cacheEvents: [],
    modelVersion: buildJudgeModelVersion(args.env),
    weightVersion: args.calibrationSnapshot.id,
    calibrationVersion: args.calibrationSnapshot.id,
    status: noEvidence ? "insufficient_evidence" as const : "completed" as const,
  };

  return VerdictTraceSchema.parse(verdictTrace);
}

class DefaultJudgeClient implements JudgeClient {
  constructor(private readonly env: AppEnv) {}

  async judge(input: {
    event: EventRecord;
    evaluationTime: string;
    evidence: JudgmentEvidenceItem[];
    calibrationSnapshot: CalibrationSnapshot;
    mode: AdapterMode;
  }): Promise<VerdictTrace> {
    if (input.mode === "fixture") {
      return buildFixtureVerdictTrace({
        ...input,
        env: this.env,
      });
    }

    const response = await fetch(`${this.env.JUDGE_BASE_URL}/judge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        eventId: input.event.id,
        event: {
          question: input.event.question,
          resolutionCriteria: input.event.resolutionCriteria,
          deadline: input.event.deadline,
          entities: input.event.entities,
          referenceClass: input.event.referenceClass,
          marketSymbols: input.event.marketSymbols,
          polymarketMarketId: input.event.polymarketMarketId,
        },
        evaluationTime: input.evaluationTime,
        evidence: input.evidence,
        calibrationSnapshot: input.calibrationSnapshot,
      }),
    });

    if (!response.ok) {
      throw new Error(`Judge service returned ${response.status} ${response.statusText}`);
    }

    return VerdictTraceSchema.parse(await response.json());
  }
}

function hasConfiguredSecret(value: string | undefined): boolean {
  const trimmed = value?.trim();

  return Boolean(trimmed && trimmed.toLowerCase() !== "replace-me");
}

function hasConfiguredAuthoritativeSearchProvider(env: AppEnv): boolean {
  return hasConfiguredSecret(env.ZAI_API_KEY) || hasConfiguredSecret(env.PERPLEXITY_API_KEY);
}

export function assertLiveAuthoritativeSearchProviderConfigured(env: AppEnv): void {
  if (env.CASSANDRA_ADAPTER_MODE !== "live") {
    return;
  }

  if (!hasConfiguredAuthoritativeSearchProvider(env)) {
    throw new Error(LIVE_AUTHORITATIVE_SEARCH_PROVIDER_REQUIRED_MESSAGE);
  }
}

function hasConfiguredCustomMarketBaseUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.hostname !== "example-market-provider.local";
  } catch {
    return false;
  }
}

export function createDefaultEvidenceProviders(env: AppEnv): EvidenceProvider[] {
  const providers: EvidenceProvider[] = [];

  if (hasConfiguredSecret(env.ZAI_API_KEY)) {
    providers.push(
      createOfficialSearchProvider({
        zaiApiKey: env.ZAI_API_KEY,
      }),
      createGovernmentSearchProvider({
        zaiApiKey: env.ZAI_API_KEY,
      }),
      createCommunitySearchProvider({
        zaiApiKey: env.ZAI_API_KEY,
      }),
      createWebProvider({
        zaiApiKey: env.ZAI_API_KEY,
      }),
    );
  }

  if (hasConfiguredSecret(env.PERPLEXITY_API_KEY)) {
    providers.push(
      createPerplexityProvider({
        apiKey: env.PERPLEXITY_API_KEY,
      }),
    );
  }

  if (hasConfiguredCustomMarketBaseUrl(env.CUSTOM_MARKET_API_BASE_URL)) {
    providers.push(
      createMarketProvider({
        baseUrl: env.CUSTOM_MARKET_API_BASE_URL,
        apiKey: hasConfiguredSecret(env.CUSTOM_MARKET_API_KEY)
          ? env.CUSTOM_MARKET_API_KEY
          : undefined,
      }),
    );
  }

  providers.push(
    createPolymarketGammaProvider({
      baseUrl: env.POLYMARKET_GAMMA_URL,
    }),
    createPolymarketClobProvider({
      baseUrl: env.POLYMARKET_CLOB_URL,
    }),
  );

  return providers;
}

async function getOrCreateCalibrationSnapshot(pool: Pool): Promise<CalibrationSnapshot> {
  const existing = await getLatestCalibrationSnapshot(pool);

  if (existing) {
    return existing;
  }

  return retrainCalibrationSnapshot(pool, await countOutcomes(pool));
}

async function loadJudgmentDetails(
  pool: Pool,
  judgmentId: string,
): Promise<JudgmentRecordDetails | null> {
  const judgment = await getJudgmentById(pool, judgmentId);

  if (!judgment) {
    return null;
  }

  return {
    ...judgment,
    judgeOpinions: await listJudgeOpinionsForJudgment(pool, judgmentId),
  };
}

function validateLiveVerdictTrace(args: {
  event: EventRecord;
  trace: VerdictTrace;
}): VerdictTrace {
  if (args.trace.eventId !== args.event.id) {
    throw new Error(
      `Judge trace eventId mismatch: expected ${args.event.id}, got ${args.trace.eventId}`,
    );
  }

  if (
    args.trace.status === "completed" &&
    args.trace.citations.some((citation) => isPlaceholderCitationUrl(citation.url))
  ) {
    throw new Error("Judge trace contains placeholder citations in live mode.");
  }

  return args.trace;
}

export async function evaluateEventForecast(
  args: EvaluateEventForecastArgs,
): Promise<VerdictTrace> {
  const judgeCacheStore = args.judgeCacheStore ?? new InMemoryJudgeCacheStore();
  const judgeClient = args.judgeClient ?? new DefaultJudgeClient(args.env);
  const evidenceForJudge = selectEvidenceForJudgeInput(
    args.event,
    mapEvidenceForJudge(args.evidence),
  );

  const cached = await getOrCreateCachedJudgeResult({
    cacheStore: judgeCacheStore,
    mode: args.env.CASSANDRA_ADAPTER_MODE,
    cacheKeyParts: {
      judgeName: "panel",
      eventId: args.event.id,
      eventQuestion: args.event.question,
      evaluationTime: args.evaluationTime,
      evidenceFingerprint: buildEvidenceFingerprint(evidenceForJudge),
      judgeModelVersion: buildJudgeModelVersion(args.env),
      promptVersion: PROMPT_VERSION,
      snapshotId: args.calibrationSnapshot.id,
    },
    load: async () =>
      {
        const trace = await judgeClient.judge({
          event: args.event,
          evaluationTime: args.evaluationTime,
          evidence: evidenceForJudge,
          calibrationSnapshot: args.calibrationSnapshot,
          mode: args.env.CASSANDRA_ADAPTER_MODE,
        });
        const validatedTrace = args.env.CASSANDRA_ADAPTER_MODE === "live"
          ? validateLiveVerdictTrace({
              event: args.event,
              trace,
            })
          : trace;

        return sanitizeTraceCitations({
          event: args.event,
          evidence: evidenceForJudge,
          trace: validatedTrace,
        });
      },
  });

  const validatedTrace =
    args.env.CASSANDRA_ADAPTER_MODE === "live"
      ? validateLiveVerdictTrace({
          event: args.event,
          trace: cached.value,
        })
      : cached.value;

  return appendJudgeCacheEvent(
    sanitizeTraceCitations({
      event: args.event,
      evidence: evidenceForJudge,
      trace: validatedTrace,
    }),
    cached.cacheStatus,
  );
}

export async function runJudgment(args: JudgmentServiceDeps & {
  input: RunJudgmentInput;
}): Promise<JudgmentRecordDetails> {
  if (!args.evidenceProviders) {
    assertLiveAuthoritativeSearchProviderConfigured(args.env);
  }
  const judgment = await getJudgmentById(args.pool, args.input.judgmentId);

  if (!judgment) {
    throw new Error(`Judgment not found: ${args.input.judgmentId}`);
  }

  const event = await getEventById(args.pool, judgment.eventId);

  if (!event || event.id !== args.input.eventId) {
    await updateJudgmentStatus(args.pool, args.input.judgmentId, "failed");
    await recordJudgmentExecutionLog({
      pool: args.pool,
      judgmentId: args.input.judgmentId,
      logger: args.logger,
      entry: buildJudgmentExecutionLogEntry({
        stage: "run",
        level: "error",
        message: "Judgment failed because the event could not be loaded.",
        details: {
          expectedEventId: args.input.eventId,
          storedEventId: judgment.eventId,
        },
      }),
    });
    throw new Error(`Event not found: ${args.input.eventId}`);
  }

  const evaluationTime = args.input.evaluationTime ?? DEFAULT_EVALUATION_TIME();
  const evidenceProviders = args.evidenceProviders ?? createDefaultEvidenceProviders(args.env);
  const evidenceCacheStore =
    args.evidenceCacheStore ?? new InMemoryEvidenceCacheStore();
  const judgeCacheStore = args.judgeCacheStore ?? new InMemoryJudgeCacheStore();
  const judgeClient = args.judgeClient ?? new DefaultJudgeClient(args.env);
  const logger = args.logger?.child({
    operation: "judgment_run",
    evaluationTime,
  });
  await updateJudgmentStatus(args.pool, judgment.id, "running");
  await recordJudgmentExecutionLog({
    pool: args.pool,
    judgmentId: judgment.id,
    logger,
    entry: buildJudgmentExecutionLogEntry({
      stage: "run",
      message: "Judgment worker started.",
      details: {
        adapterMode: args.env.CASSANDRA_ADAPTER_MODE,
        evaluationTime,
      },
    }),
  });

  try {
    logger?.info(
      {
        event: "judgment_started",
      },
      "judgment started",
    );
    const collected = await collectEvidenceForEventWithCache({
      pool: args.pool,
      event,
      evaluationTime,
      mode: args.env.CASSANDRA_ADAPTER_MODE,
      providers: evidenceProviders,
      cacheStore: evidenceCacheStore,
      logger,
    });
    const failedProviders = collected.providerRuns.filter((run) => run.error);
    await recordJudgmentExecutionLog({
      pool: args.pool,
      judgmentId: judgment.id,
      logger,
      entry: buildJudgmentExecutionLogEntry({
        stage: "evidence",
        message: "Evidence collection finished.",
        details: {
          evidenceCount: collected.items.length,
          providerRuns: collected.providerRuns.map((run) => ({
            providerName: run.providerName,
            rawCount: run.rawCount,
            normalizedCount: run.normalizedCount,
            cacheStatus: run.cacheStatus,
            error: run.error ?? null,
          })),
        },
      }),
    });
    logger?.info(
      {
        event: "judgment_evidence_ready",
        evidenceCount: collected.items.length,
        providerCount: collected.providerRuns.length,
        failedProviderCount: failedProviders.length,
        providerDetails: collected.providerRuns.map((run) => ({
          name: run.providerName,
          rawCount: run.rawCount,
          cacheStatus: run.cacheStatus,
          error: run.error ?? null,
        })),
      },
      "judgment evidence ready",
    );
    if (failedProviders.length > 0) {
      await recordJudgmentExecutionLog({
        pool: args.pool,
        judgmentId: judgment.id,
        logger,
        entry: buildJudgmentExecutionLogEntry({
          stage: "evidence",
          level: "warn",
          message: "One or more evidence providers failed during the run.",
          details: {
            failedProviders: failedProviders.map((run) => ({
              providerName: run.providerName,
              error: run.error ?? null,
            })),
          },
        }),
      });
      logger?.warn(
        {
          event: "judgment_providers_degraded",
          failedProviders: failedProviders.map((run) => ({
            name: run.providerName,
            error: run.error,
          })),
        },
        `${failedProviders.length} of ${collected.providerRuns.length} evidence provider(s) failed`,
      );
    }
    const calibrationSnapshot = await getOrCreateCalibrationSnapshot(args.pool);
    await recordJudgmentExecutionLog({
      pool: args.pool,
      judgmentId: judgment.id,
      logger,
      entry: buildJudgmentExecutionLogEntry({
        stage: "calibration",
        message: "Calibration snapshot loaded.",
        details: {
          calibrationSnapshotId: calibrationSnapshot.id,
          weightRegime: calibrationSnapshot.weightRegime,
          approved: calibrationSnapshot.approved,
          resolvedOutcomeCount: calibrationSnapshot.resolvedOutcomeCount,
        },
      }),
    });
    const evidenceForCoverage = selectEvidenceForJudgeInput(event, collected.items.map((item) => ({
      id: item.id,
      eventId: item.eventId,
      title: item.title,
      url: item.url,
      summary: item.summary,
      publishedAt: item.publishedAt,
      sourceFamily: item.sourceFamily,
      sourceType: item.sourceType,
      publisher: item.publisher,
      retrievedAt: item.retrievedAt,
      rawText: item.rawText,
      entities: item.entities,
      claims: item.claims,
      stance: item.stance,
      qualitySignals: item.qualitySignals,
      metadata: item.metadata,
    })));
    const liveCoverage =
      args.env.CASSANDRA_ADAPTER_MODE === "live"
        ? assessLiveCoverage(event, evidenceForCoverage)
        : null;
    if (liveCoverage) {
      await recordJudgmentExecutionLog({
        pool: args.pool,
        judgmentId: judgment.id,
        logger,
        entry: buildJudgmentExecutionLogEntry({
          stage: "coverage",
          level: liveCoverage.hasEnoughCitationCoverage ? "info" : "warn",
          message: liveCoverage.hasEnoughCitationCoverage
            ? "Live evidence coverage passed the minimum citation threshold."
            : "Live evidence coverage was too weak for a normal completed verdict.",
          details: {
            uniqueCitationCount: liveCoverage.uniqueCitationCount,
            hasEnoughCitationCoverage: liveCoverage.hasEnoughCitationCoverage,
            selectedEvidenceCount: evidenceForCoverage.length,
          },
        }),
      });
    }
    const verdictTrace =
      liveCoverage && !liveCoverage.hasEnoughCitationCoverage
        ? buildInsufficientEvidenceVerdictTrace({
            env: args.env,
            event,
            evidence: evidenceForCoverage,
            evaluationTime,
            calibrationSnapshot,
          })
        : await evaluateEventForecast({
            env: args.env,
            event,
            evaluationTime,
            evidence: collected.items,
            calibrationSnapshot,
            judgeCacheStore,
            judgeClient,
          });
    await recordJudgmentExecutionLog({
      pool: args.pool,
      judgmentId: judgment.id,
      logger,
      entry: buildJudgmentExecutionLogEntry({
        stage: "judge",
        message: "Judge output is ready.",
        level: verdictTrace.status === "failed" ? "error" : verdictTrace.status === "insufficient_evidence" ? "warn" : "info",
        details: {
          judgmentStatus: verdictTrace.status,
          finalProbability: verdictTrace.finalProbability,
          citationCount: verdictTrace.citations.length,
          judgeOpinionCount: verdictTrace.judgeOpinions.length,
          cacheEvents: verdictTrace.cacheEvents,
        },
      }),
    });

    await appendJudgmentTrace(args.pool, judgment.id, verdictTrace);
    await recordJudgmentExecutionLog({
      pool: args.pool,
      judgmentId: judgment.id,
      logger,
      entry: buildJudgmentExecutionLogEntry({
        stage: "storage",
        message: "Judgment trace and opinions were persisted.",
        details: {
          verdictStatus: verdictTrace.status,
          storedJudgeOpinionCount: verdictTrace.judgeOpinions.length,
        },
      }),
    });

    const stored = await loadJudgmentDetails(args.pool, judgment.id);

    if (!stored) {
      throw new Error(`Stored judgment not found after persistence: ${judgment.id}`);
    }

    logger?.info(
      {
        event: "judgment_completed",
        finalProbability: stored.verdictTrace?.finalProbability ?? null,
        status: stored.status,
      },
      "judgment completed",
    );

    return stored;
  } catch (error) {
    await updateJudgmentStatus(args.pool, judgment.id, "failed");
    await recordJudgmentExecutionLog({
      pool: args.pool,
      judgmentId: judgment.id,
      logger,
      entry: buildJudgmentExecutionLogEntry({
        stage: "run",
        level: "error",
        message: "Judgment run failed.",
        details: {
          error:
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Unknown error",
        },
      }),
    });
    logger?.error(
      {
        event: "judgment_failed",
        err: error,
      },
      "judgment failed",
    );
    throw error;
  }
}

export async function getJudgmentDetails(
  pool: Pool,
  judgmentId: string,
): Promise<JudgmentRecordDetails | null> {
  return loadJudgmentDetails(pool, judgmentId);
}

export async function listRuntimeEvents(
  pool: Pool,
  filters: ListRuntimeEventsFilters = {},
): Promise<RuntimeEventRecord[]> {
  const judgments = await listJudgments(pool);
  const normalizedSearch = filters.search?.trim().toLowerCase();
  const runtimeEvents = judgments
    .flatMap((judgment) =>
      judgment.executionLog.map((entry) => ({
        judgmentId: judgment.id,
        eventId: judgment.eventId,
        judgmentStatus: judgment.status as RuntimeEventRecord["judgmentStatus"],
        finalProbability: judgment.verdictTrace?.finalProbability ?? null,
        entry,
      })),
    )
    .filter((item) => {
      if (filters.judgmentStatus && item.judgmentStatus !== filters.judgmentStatus) {
        return false;
      }

      if (filters.stage && item.entry.stage !== filters.stage) {
        return false;
      }

      if (filters.level && item.entry.level !== filters.level) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const haystack = [
        item.judgmentId,
        item.eventId,
        item.entry.message,
        JSON.stringify(item.entry.details),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    })
    .sort((left, right) => right.entry.timestamp.localeCompare(left.entry.timestamp));

  const limit = filters.limit && filters.limit > 0 ? filters.limit : undefined;
  return typeof limit === "number" ? runtimeEvents.slice(0, limit) : runtimeEvents;
}

export async function enqueueJudgmentRun(
  pool: Pool,
  eventId: string,
): Promise<JudgmentRecord> {
  const event = await getEventById(pool, eventId);

  if (!event) {
    throw new Error(`Event not found: ${eventId}`);
  }

  return createJudgmentRun(pool, eventId, [
    buildJudgmentExecutionLogEntry({
      stage: "queue",
      message: "Judgment was queued for background processing.",
      details: {
        eventId,
      },
    }),
  ]);
}

export function createEvidenceCacheStore(
  redisConnection?: Redis,
): EvidenceCacheStore {
  return redisConnection
    ? createRedisEvidenceCacheStore(redisConnection)
    : new InMemoryEvidenceCacheStore();
}

export function createJudgeCacheStore(
  redisConnection?: Redis,
): JudgeCacheStore {
  return redisConnection
    ? createRedisJudgeCacheStore(redisConnection)
    : new InMemoryJudgeCacheStore();
}
