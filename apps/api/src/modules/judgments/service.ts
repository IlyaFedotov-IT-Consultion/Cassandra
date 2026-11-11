import { randomUUID } from "node:crypto";

import {
  type EvidenceItem,
  type JudgmentExecutionLogEntry,
  type RuntimeEventRecord,
  VerdictTraceSchema,
  type CalibrationSnapshot,
  type JudgeOpinion,
  type PipelineStage,
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
import {
  createOpenRouterWebSearch,
  createZaiWebSearch,
  type WebSearchFn,
} from "../evidence/providers/webSearch.js";
import type { AdapterMode, EvidenceProvider } from "../evidence/types.js";
import { getEventById, type EventRecord } from "../events/repository.js";
import { getActiveCalibrationSnapshot } from "../backtests/repository.js";
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
const PROMPT_VERSION = "prompt-v3";
const MIN_COMPLETED_LIVE_CITATIONS = 2;
// The judge service's relevance stage ranks and filters these candidates.
const MAX_EVIDENCE_ITEMS_PER_JUDGE = 6;
const MAX_MARKET_PRIOR_ITEMS = 4;
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
  "Live judgments require at least one configured authoritative search provider. Set ZAI_API_KEY, OPENROUTER_API_KEY or PERPLEXITY_API_KEY, or switch to CASSANDRA_ADAPTER_MODE=fixture.";
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
    sourceFamilies: ["web", "llm_research"] as const,
    missingSourceFamily: "web",
  },
] as const;

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
    /** Coverage was too weak for the panel: return a prior-only insufficient_evidence trace. */
    priorOnly?: boolean;
  }): Promise<VerdictTrace>;
  /** Pipeline stage 1: decompose the question into sub-questions with search queries. */
  plan?(input: {
    event: EventRecord;
    evaluationTime: string;
    maxQueries: number;
  }): Promise<QueryPlanResult>;
}

export interface QueryPlanResult {
  subQuestions: string[];
  queries: string[];
  model?: string | null;
}

const MAX_PLANNED_QUERIES = 3;

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

  // The entry's level picks the logger method and its timestamp matches the line's own
  // `time`, so neither is repeated in the payload (that would write those keys twice).
  const payload = {
    event: "judgment_execution_log",
    stage: args.entry.stage,
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
    env.CASSANDRA_JUDGE_LLM ?? "default-judge-llm",
    env.OPENROUTER_JUDGE_MODELS ?? env.OPENROUTER_JUDGE_MODEL ?? "default-judge",
    env.OPENROUTER_JUDGE_REASONING_EFFORT ?? "default-effort",
    env.OPENROUTER_UTILITY_MODEL ?? "default-utility",
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

function readLiquidity(item: JudgmentEvidenceItem): number {
  const value = item.metadata.liquidity ?? item.metadata.depth;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Per-judge quotas: each panel judge gets up to MAX_EVIDENCE_ITEMS_PER_JUDGE items,
 * round-robin across its source families so no family starves another. Prediction-market
 * items feed the prior (not a judge), so they are selected separately, most liquid first.
 */
function selectEvidenceForJudgeInput(
  event: EventRecord,
  evidence: JudgmentEvidenceItem[],
): JudgmentEvidenceItem[] {
  const relevantEvidence = evidence.filter((item) => isEventRelevantEvidence(event, item));
  const candidateEvidence = relevantEvidence.length > 0 ? relevantEvidence : evidence;
  const sortedEvidence = [...candidateEvidence].sort(compareEvidenceForJudging);
  const selectedEvidence: JudgmentEvidenceItem[] = [];

  for (const panelJudge of PANEL_JUDGES) {
    const familyQueues = panelJudge.sourceFamilies.map((family) =>
      sortedEvidence.filter((item) => item.sourceFamily === family),
    );
    let taken = 0;

    for (let round = 0; taken < MAX_EVIDENCE_ITEMS_PER_JUDGE; round += 1) {
      const roundItems = familyQueues.flatMap((queue) => {
        const item = queue[round];
        return item ? [item] : [];
      });

      if (roundItems.length === 0) {
        break;
      }

      for (const item of roundItems.slice(0, MAX_EVIDENCE_ITEMS_PER_JUDGE - taken)) {
        selectedEvidence.push(item);
        taken += 1;
      }
    }
  }

  const marketPriorEvidence = sortedEvidence
    .filter((item) => item.sourceFamily === "prediction_market")
    .sort((left, right) => readLiquidity(right) - readLiquidity(left))
    .slice(0, MAX_MARKET_PRIOR_ITEMS);

  return [...selectedEvidence, ...marketPriorEvidence];
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

/** Ids the judge service logs on every line of a call, so its logs join the API's. */
export interface JudgeRequestContext {
  judgmentId?: string;
  eventId?: string;
}

export function createJudgeClient(env: AppEnv, context: JudgeRequestContext = {}): JudgeClient {
  return new DefaultJudgeClient(env, context);
}

class DefaultJudgeClient implements JudgeClient {
  constructor(
    private readonly env: AppEnv,
    private readonly context: JudgeRequestContext = {},
  ) {}

  private requestHeaders(event: EventRecord): { requestId: string; headers: Record<string, string> } {
    const requestId = randomUUID();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-cassandra-event-id": this.context.eventId ?? event.id,
    };

    if (this.context.judgmentId) {
      headers["x-cassandra-judgment-id"] = this.context.judgmentId;
    }

    return { requestId, headers };
  }

  async judge(input: Parameters<JudgeClient["judge"]>[0]): Promise<VerdictTrace> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.JUDGE_REQUEST_TIMEOUT_MS);
    const { requestId, headers } = this.requestHeaders(input.event);

    try {
      const response = await fetch(`${this.env.JUDGE_BASE_URL}/judge`, {
        method: "POST",
        headers,
        signal: controller.signal,
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
          priorOnly: input.priorOnly ?? false,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Judge service returned ${response.status} ${response.statusText} (request ${requestId})`,
        );
      }

      // The timeout also covers reading the body, not only receiving headers.
      return VerdictTraceSchema.parse(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async plan(input: { event: EventRecord; evaluationTime: string; maxQueries: number }): Promise<QueryPlanResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.JUDGE_REQUEST_TIMEOUT_MS);
    const { requestId, headers } = this.requestHeaders(input.event);

    try {
      const response = await fetch(`${this.env.JUDGE_BASE_URL}/plan`, {
        method: "POST",
        headers,
        signal: controller.signal,
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
          maxQueries: input.maxQueries,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Judge service planning returned ${response.status} ${response.statusText} (request ${requestId})`,
        );
      }

      const payload = (await response.json()) as Partial<QueryPlanResult>;
      return {
        subQuestions: Array.isArray(payload.subQuestions) ? payload.subQuestions.map(String) : [],
        queries: Array.isArray(payload.queries) ? payload.queries.map(String) : [],
        model: typeof payload.model === "string" ? payload.model : null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function pipelineStage(
  stage: string,
  status: PipelineStage["status"],
  details: Record<string, unknown>,
): PipelineStage {
  return { stage, status, details };
}

/**
 * Pipeline stage 1. Planning is best effort: when the client cannot plan or planning
 * fails, retrieval falls back to each provider's templated query.
 */
export async function planEventQueries(args: {
  env: AppEnv;
  event: EventRecord;
  evaluationTime: string;
  judgeClient?: JudgeClient;
}): Promise<{ queries: string[]; stage: PipelineStage }> {
  const judgeClient = args.judgeClient ?? new DefaultJudgeClient(args.env);

  if (typeof judgeClient.plan !== "function") {
    return {
      queries: [],
      stage: pipelineStage("query_planning", "skipped", { reason: "judge client cannot plan" }),
    };
  }

  try {
    const plan = await judgeClient.plan({
      event: args.event,
      evaluationTime: args.evaluationTime,
      maxQueries: MAX_PLANNED_QUERIES,
    });
    const queries = plan.queries.map((query) => query.trim()).filter(Boolean).slice(0, MAX_PLANNED_QUERIES);

    return {
      queries,
      stage: pipelineStage("query_planning", queries.length > 0 ? "completed" : "skipped", {
        subQuestions: plan.subQuestions,
        queries,
        model: plan.model ?? null,
      }),
    };
  } catch (error) {
    return {
      queries: [],
      stage: pipelineStage("query_planning", "failed", {
        error: error instanceof Error ? error.message : String(error),
        fallback: "templated provider queries",
      }),
    };
  }
}

function withLeadingPipelineStages(trace: VerdictTrace, stages: PipelineStage[]): VerdictTrace {
  return VerdictTraceSchema.parse({
    ...trace,
    pipelineStages: [...stages, ...(trace.pipelineStages ?? [])],
  });
}

function hasConfiguredSecret(value: string | undefined): boolean {
  const trimmed = value?.trim();

  return Boolean(trimmed && trimmed.toLowerCase() !== "replace-me");
}

const OPENROUTER_GOVERNMENT_DOMAINS = ["*.gov", "*.gov.uk", "europa.eu", "*.europa.eu", "*.int"];

function resolveSearchBackend(env: AppEnv): "zai" | "openrouter" | null {
  const zaiConfigured = hasConfiguredSecret(env.ZAI_API_KEY);
  const openRouterConfigured = hasConfiguredSecret(env.OPENROUTER_API_KEY);

  switch (env.CASSANDRA_SEARCH_BACKEND) {
    case "zai":
      return zaiConfigured ? "zai" : null;
    case "openrouter":
      return openRouterConfigured ? "openrouter" : null;
    case "auto":
      return zaiConfigured ? "zai" : openRouterConfigured ? "openrouter" : null;
  }
}

/** The configured live web search, shared by evidence providers and research runs. */
export function createConfiguredWebSearch(env: AppEnv): WebSearchFn | null {
  switch (resolveSearchBackend(env)) {
    case "zai":
      return createZaiWebSearch(env.ZAI_API_KEY);
    case "openrouter":
      return createOpenRouterWebSearch({
        apiKey: env.OPENROUTER_API_KEY ?? "",
        model: env.OPENROUTER_WEB_SEARCH_MODEL,
        engine: env.OPENROUTER_WEB_SEARCH_ENGINE,
      });
    default:
      return null;
  }
}

function hasConfiguredAuthoritativeSearchProvider(env: AppEnv): boolean {
  return resolveSearchBackend(env) !== null || hasConfiguredSecret(env.PERPLEXITY_API_KEY);
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

  const search = createConfiguredWebSearch(env);

  if (search) {
    const backend = resolveSearchBackend(env);
    providers.push(
      createOfficialSearchProvider({ search }),
      createGovernmentSearchProvider({
        search,
        // OpenRouter accepts wildcard domain filters, so it can cover every government TLD.
        domains: backend === "openrouter" ? OPENROUTER_GOVERNMENT_DOMAINS : undefined,
      }),
      createCommunitySearchProvider({ search }),
      createWebProvider({ search }),
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

/**
 * Coverage was too weak for a panel verdict: ask the judge service for a prior-only
 * trace (market and base-rate prior, no LLM calls) so the prior math lives in one place.
 */
export async function evaluatePriorOnlyForecast(
  args: EvaluateEventForecastArgs,
): Promise<VerdictTrace> {
  const judgeClient = args.judgeClient ?? new DefaultJudgeClient(args.env);
  const evidenceForJudge = selectEvidenceForJudgeInput(
    args.event,
    mapEvidenceForJudge(args.evidence),
  );
  const trace = await judgeClient.judge({
    event: args.event,
    evaluationTime: args.evaluationTime,
    evidence: evidenceForJudge,
    calibrationSnapshot: args.calibrationSnapshot,
    mode: args.env.CASSANDRA_ADAPTER_MODE,
    priorOnly: true,
  });

  if (trace.eventId !== args.event.id) {
    throw new Error(
      `Judge trace eventId mismatch: expected ${args.event.id}, got ${trace.eventId}`,
    );
  }

  return VerdictTraceSchema.parse({
    ...trace,
    status: "insufficient_evidence",
    missingEvidence: buildMissingEvidence(args.event, evidenceForJudge),
  });
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
  const judgeClient =
    args.judgeClient ?? createJudgeClient(args.env, { judgmentId: judgment.id, eventId: event.id });
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
    const planning = await planEventQueries({
      env: args.env,
      event,
      evaluationTime,
      judgeClient,
    });
    await recordJudgmentExecutionLog({
      pool: args.pool,
      judgmentId: judgment.id,
      logger,
      entry: buildJudgmentExecutionLogEntry({
        stage: "planning",
        level: planning.stage.status === "failed" ? "warn" : "info",
        message:
          planning.stage.status === "completed"
            ? "Planned sub-question search queries."
            : "Query planning did not produce queries; using templated provider queries.",
        details: planning.stage.details,
      }),
    });
    const collected = await collectEvidenceForEventWithCache({
      pool: args.pool,
      event,
      evaluationTime,
      mode: args.env.CASSANDRA_ADAPTER_MODE,
      providers: evidenceProviders,
      cacheStore: evidenceCacheStore,
      logger,
      queries: planning.queries,
    });
    const retrievalStage = pipelineStage(
      "retrieval",
      collected.providerRuns.every((run) => run.error) ? "failed" : "completed",
      {
        plannedQueries: planning.queries.length,
        evidenceCount: collected.items.length,
        providers: collected.providerRuns.map((run) => ({
          name: run.providerName,
          rawCount: run.rawCount,
          cacheStatus: run.cacheStatus,
          error: run.error ?? null,
        })),
      },
    );
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
    const calibrationSnapshot = await getActiveCalibrationSnapshot(args.pool);
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
    const panelTrace =
      liveCoverage && !liveCoverage.hasEnoughCitationCoverage
        ? await evaluatePriorOnlyForecast({
            env: args.env,
            event,
            evaluationTime,
            evidence: collected.items,
            calibrationSnapshot,
            judgeClient,
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
    const verdictTrace = withLeadingPipelineStages(panelTrace, [planning.stage, retrievalStage]);
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
