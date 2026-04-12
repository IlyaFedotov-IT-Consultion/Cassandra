import { randomUUID } from "node:crypto";

import {
  type EvidenceItem,
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
import {
  createMarketProvider,
} from "../evidence/providers/marketProvider.js";
import { createPerplexityProvider } from "../evidence/providers/perplexity.js";
import { createPolymarketClobProvider } from "../evidence/providers/polymarketClob.js";
import { createPolymarketGammaProvider } from "../evidence/providers/polymarketGamma.js";
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
  appendJudgmentTrace,
  createJudgmentRun,
  getJudgmentById,
  listJudgeOpinionsForJudgment,
  type JudgmentRecord,
  updateJudgmentStatus,
} from "./repository.js";

const DEFAULT_EVALUATION_TIME = () => new Date().toISOString();
const JUDGE_MODEL_VERSION = "judge-fixture-v1";
const PROMPT_VERSION = "prompt-v1";
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

export interface JudgmentRecordDetails extends JudgmentRecord {
  judgeOpinions: JudgeOpinion[];
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

function buildCitations(evidence: JudgmentEvidenceItem[]): CitationRecord[] {
  const seen = new Set<string>();
  const citations: CitationRecord[] = [];

  for (const item of evidence) {
    if (seen.has(item.url)) {
      continue;
    }

    seen.add(item.url);
    citations.push({
      title: item.title,
      url: item.url,
      sourceFamily: item.sourceFamily,
    });
  }

  return citations;
}

function buildFallbackCitation(event: EventRecord): CitationRecord {
  return {
    title: event.question,
    url: "https://example.invalid/no-evidence",
    sourceFamily: "web",
  };
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
    modelVersion: JUDGE_MODEL_VERSION,
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
      return buildFixtureVerdictTrace(input);
    }

    const response = await fetch(`${this.env.JUDGE_BASE_URL}/judge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
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

function createDefaultEvidenceProviders(env: AppEnv): EvidenceProvider[] {
  return [
    createPerplexityProvider({
      apiKey: env.PERPLEXITY_API_KEY,
    }),
    createMarketProvider({
      baseUrl: env.CUSTOM_MARKET_API_BASE_URL,
      apiKey: env.CUSTOM_MARKET_API_KEY,
    }),
    createPolymarketGammaProvider({
      baseUrl: env.POLYMARKET_GAMMA_URL,
    }),
    createPolymarketClobProvider({
      baseUrl: env.POLYMARKET_CLOB_URL,
    }),
  ];
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

export async function evaluateEventForecast(
  args: EvaluateEventForecastArgs,
): Promise<VerdictTrace> {
  const judgeCacheStore = args.judgeCacheStore ?? new InMemoryJudgeCacheStore();
  const judgeClient = args.judgeClient ?? new DefaultJudgeClient(args.env);
  const evidenceForJudge: JudgmentEvidenceItem[] = args.evidence.map((item) => ({
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

  const cached = await getOrCreateCachedJudgeResult({
    cacheStore: judgeCacheStore,
    mode: args.env.CASSANDRA_ADAPTER_MODE,
    cacheKeyParts: {
      judgeName: "panel",
      evidenceIds: evidenceForJudge.map((item) => item.id),
      judgeModelVersion: JUDGE_MODEL_VERSION,
      promptVersion: PROMPT_VERSION,
      snapshotId: args.calibrationSnapshot.id,
    },
    load: async () =>
      judgeClient.judge({
        event: args.event,
        evaluationTime: args.evaluationTime,
        evidence: evidenceForJudge,
        calibrationSnapshot: args.calibrationSnapshot,
        mode: args.env.CASSANDRA_ADAPTER_MODE,
      }),
  });

  return appendJudgeCacheEvent(cached.value, cached.cacheStatus);
}

export async function runJudgment(args: JudgmentServiceDeps & {
  input: RunJudgmentInput;
}): Promise<JudgmentRecordDetails> {
  const judgment = await getJudgmentById(args.pool, args.input.judgmentId);

  if (!judgment) {
    throw new Error(`Judgment not found: ${args.input.judgmentId}`);
  }

  const event = await getEventById(args.pool, judgment.eventId);

  if (!event || event.id !== args.input.eventId) {
    await updateJudgmentStatus(args.pool, args.input.judgmentId, "failed");
    throw new Error(`Event not found: ${args.input.eventId}`);
  }

  const evaluationTime = args.input.evaluationTime ?? DEFAULT_EVALUATION_TIME();
  const evidenceProviders = args.evidenceProviders ?? createDefaultEvidenceProviders(args.env);
  const evidenceCacheStore =
    args.evidenceCacheStore ?? new InMemoryEvidenceCacheStore();
  const judgeCacheStore = args.judgeCacheStore ?? new InMemoryJudgeCacheStore();
  const judgeClient = args.judgeClient ?? new DefaultJudgeClient(args.env);
  const logger = args.logger?.child({
    component: "judgment_run",
    evaluationTime,
  });
  await updateJudgmentStatus(args.pool, judgment.id, "running");

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
    logger?.info(
      {
        event: "judgment_evidence_ready",
        evidenceCount: collected.items.length,
        providerCount: collected.providerRuns.length,
      },
      "judgment evidence ready",
    );
    const calibrationSnapshot = await getOrCreateCalibrationSnapshot(args.pool);
    const verdictTrace = await evaluateEventForecast({
      env: args.env,
      event,
      evaluationTime,
      evidence: collected.items,
      calibrationSnapshot,
      judgeCacheStore,
      judgeClient,
    });

    await appendJudgmentTrace(args.pool, judgment.id, verdictTrace);

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

export async function enqueueJudgmentRun(
  pool: Pool,
  eventId: string,
): Promise<JudgmentRecord> {
  const event = await getEventById(pool, eventId);

  if (!event) {
    throw new Error(`Event not found: ${eventId}`);
  }

  return createJudgmentRun(pool, eventId);
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
