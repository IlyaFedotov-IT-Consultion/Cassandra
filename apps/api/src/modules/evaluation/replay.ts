import type {
  BenchmarkMarket,
  CalibrationSnapshot,
  EvidenceItem,
  EventInput,
  EvaluationRun,
} from "@cassandra/shared";
import type { Pool } from "pg";

import type { AppEnv } from "../../config/env.js";
import { getActiveCalibrationSnapshot } from "../backtests/repository.js";
import {
  InMemoryEvidenceCacheStore,
  buildEvidenceCacheKey,
  type EvidenceCacheStore,
} from "../evidence/cache.js";
import { normalizeEvidenceItems } from "../evidence/normalize.js";
import type { EvidenceProvider } from "../evidence/types.js";
import type { EventRecord } from "../events/repository.js";
import { InMemoryJudgeCacheStore, type JudgeCacheStore } from "../judgments/judgeCache.js";
import {
  assessLiveCoverageForEvidence,
  assertLiveAuthoritativeSearchProviderConfigured,
  createDefaultEvidenceProviders as createDefaultJudgmentEvidenceProviders,
  evaluateEventForecast,
  evaluatePriorOnlyForecast,
  type JudgeClient,
} from "../judgments/service.js";
import {
  assertNoPolymarketLeak,
  computeBaseRateOnlyProbability,
  computeBenchmarkBaseRate,
  providersForBaseline,
  selectPolymarketSnapshotAtCutoff,
} from "./baselines.js";
import {
  averageAbsoluteError,
  brierScore,
  clusteredBrierDifference,
  expectedCalibrationError,
  logLoss,
  sliceMetrics,
  winRateVsReference,
  type EvaluationPair,
} from "./metrics.js";
import { assertLiveEvaluationMode } from "./liveMode.js";
import {
  completeEvaluationRun,
  createEvaluationRunWithPredictions as persistEvaluationRunWithPredictions,
  failEvaluationRun,
  getEvaluationRunRequest,
  insertEvaluationPredictions,
  listBenchmarkMarkets as loadBenchmarkMarkets,
  listEvaluationPredictionsForRun,
  listPriceSnapshotsForBenchmark as loadPriceSnapshotsForBenchmark,
  markEvaluationRunRunning,
  recordEvaluationRunProgress,
  type BenchmarkPriceSnapshotRecord,
  type EvaluationPredictionInput,
} from "./repository.js";

const REPLAY_HORIZONS = [
  {
    horizon: "30d",
    hours: 30 * 24,
  },
  {
    horizon: "7d",
    hours: 7 * 24,
  },
  {
    horizon: "1d",
    hours: 24,
  },
  {
    horizon: "6h",
    hours: 6,
  },
] as const;

const DEFAULT_BASELINES = [
  "base_rate_only",
  "polymarket_only",
  "model_without_polymarket",
  "model_with_polymarket",
] as const satisfies EvaluationRun["baselines"];
const DEFAULT_EVIDENCE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface ReplayCutoff {
  horizon: string;
  cutoffAt: string;
}

export interface RunHistoricalEvaluationInput {
  benchmarkSetId: string;
  benchmarkMarketIds?: string[];
  baselines?: EvaluationRun["baselines"];
}

/**
 * What calibration needs from one replayed forecast: the probability before any
 * calibration map, the prior it started from, and how each judge read its evidence.
 */
export interface ForecastCalibrationInputs {
  preCalibrationProbability: number | null;
  priorProbability: number;
  status: "completed" | "insufficient_evidence" | "failed" | "queued" | "running";
  calibrationVersion: string;
  judgeOpinions: Array<{ judgeName: string; logBayesFactor: number; hadEvidence: boolean }>;
}

export interface ModelBaselineEvaluationResult {
  probability: number;
  replayFidelity: EvaluationRun["replayFidelity"];
  leakageWarnings?: string[];
  calibration?: ForecastCalibrationInputs;
}

export interface EvaluateModelBaselineArgs {
  pool: Pool;
  env: AppEnv;
  event: EventRecord;
  market: BenchmarkMarket;
  cutoff: ReplayCutoff;
  baseline: "model_without_polymarket" | "model_with_polymarket";
  polymarketSnapshot: BenchmarkPriceSnapshotRecord | null;
  calibrationSnapshot: CalibrationSnapshot;
  evidenceProviders: EvidenceProvider[];
  evidenceCacheStore: EvidenceCacheStore;
  judgeCacheStore: JudgeCacheStore;
  sharedEvidenceStore: Map<string, EvidenceItem[]>;
  judgeClient?: JudgeClient;
}

/** Called after each market: its forecasts are final and can be stored. */
export type MarketCompletedHook = (args: {
  market: BenchmarkMarket;
  predictions: EvaluationPredictionInput[];
  completedMarkets: number;
  totalMarkets: number;
  replayFidelity: EvaluationRun["replayFidelity"];
  leakageWarnings: string[];
}) => Promise<void>;

interface ReplayDependencies {
  pool: Pool;
  env: AppEnv;
  evidenceProviders?: EvidenceProvider[];
  evidenceCacheStore?: EvidenceCacheStore;
  judgeCacheStore?: JudgeCacheStore;
  judgeClient?: JudgeClient;
  listBenchmarkMarkets?: (pool: Pool, benchmarkSetId: string) => Promise<BenchmarkMarket[]>;
  listPriceSnapshotsForBenchmark?: (
    pool: Pool,
    benchmarkMarketId: string,
  ) => Promise<BenchmarkPriceSnapshotRecord[]>;
  getCalibrationSnapshot?: (pool: Pool) => Promise<CalibrationSnapshot | null>;
  evaluateModelBaseline?: (
    args: EvaluateModelBaselineArgs,
  ) => Promise<ModelBaselineEvaluationResult>;
}

export interface RunHistoricalEvaluationArgs {
  pool: Pool;
  env: AppEnv;
  input: RunHistoricalEvaluationInput;
  evidenceProviders?: EvidenceProvider[];
  evidenceCacheStore?: EvidenceCacheStore;
  judgeCacheStore?: JudgeCacheStore;
  judgeClient?: JudgeClient;
  listBenchmarkMarkets?: (pool: Pool, benchmarkSetId: string) => Promise<BenchmarkMarket[]>;
  listPriceSnapshotsForBenchmark?: (
    pool: Pool,
    benchmarkMarketId: string,
  ) => Promise<BenchmarkPriceSnapshotRecord[]>;
  getCalibrationSnapshot?: (pool: Pool) => Promise<CalibrationSnapshot | null>;
  evaluateModelBaseline?: (
    args: EvaluateModelBaselineArgs,
  ) => Promise<ModelBaselineEvaluationResult>;
  persistEvaluationRunResult?: typeof persistEvaluationRunWithPredictions;
}

/** Cutoffs at each replay horizon before `anchorAt`. */
export function buildReplayCutoffs(anchorAt: string): ReplayCutoff[] {
  const anchorMillis = new Date(anchorAt).getTime();

  return REPLAY_HORIZONS.map(({ horizon, hours }) => ({
    horizon,
    cutoffAt: new Date(anchorMillis - hours * 60 * 60 * 1000).toISOString(),
  }));
}

/**
 * A market's replay cutoffs. Horizons count back from the scheduled end date, which a
 * forecaster knew in advance; the time the market actually closed depends on the outcome.
 * Cutoffs at or after the resolution are dropped, because by then the answer was public.
 */
export function buildMarketReplayCutoffs(
  market: Pick<BenchmarkMarket, "resolvedAt" | "endDate">,
): ReplayCutoff[] {
  const resolvedMillis = new Date(market.resolvedAt).getTime();

  return buildReplayCutoffs(market.endDate ?? market.resolvedAt).filter(
    (cutoff) => new Date(cutoff.cutoffAt).getTime() < resolvedMillis,
  );
}

function inferReplayEntities(question: string): string[] {
  const normalized = question.trim().replace(/\?$/, "");
  const subject =
    normalized.match(/^Will\s+(.+?)(?:\s+by\s+|\s+before\s+|\s+on\s+|\s+in\s+)/i)?.[1]
    ?? normalized.replace(/^Will\s+/i, "");

  return [subject.trim() || normalized];
}

export function buildReplayEventInput(market: BenchmarkMarket): EventInput {
  return {
    question: market.title,
    resolutionCriteria: market.resolutionCriteria,
    // The close time leaks the outcome for markets that resolved YES early; use the
    // scheduled end date the forecaster would have known.
    deadline: market.endDate ?? market.resolvedAt,
    entities: inferReplayEntities(market.title),
    referenceClass: null,
    marketSymbols: [],
    polymarketMarketId: market.id,
  };
}

export function buildReplayEventRecord(market: BenchmarkMarket): EventRecord {
  const input = buildReplayEventInput(market);

  return {
    id: `replay-${market.id}`,
    question: input.question,
    resolutionCriteria: input.resolutionCriteria,
    deadline: input.deadline,
    status: "resolved",
    entities: input.entities,
    referenceClass: input.referenceClass,
    marketSymbols: input.marketSymbols,
    polymarketMarketId: input.polymarketMarketId ?? null,
    createdAt: market.resolvedAt,
    updatedAt: market.resolvedAt,
  };
}

export function buildReplayEvidenceCacheKey(args: {
  eventId: string;
  question: string;
  cutoffAt: string;
  providerName: string;
}): string {
  return buildEvidenceCacheKey(
    `${args.eventId}:${args.question}`,
    args.cutoffAt,
    args.providerName,
  );
}

export function filterEvidenceForCutoff<T extends Pick<EvidenceItem, "publishedAt">>(
  evidence: T[],
  cutoffAt: string,
): T[] {
  const cutoffMillis = new Date(cutoffAt).getTime();

  return evidence.filter((item) => new Date(item.publishedAt).getTime() <= cutoffMillis);
}

export function inferReplayFidelity(
  evidence: Array<Pick<EvidenceItem, "metadata">>,
): EvaluationRun["replayFidelity"] {
  if (evidence.length === 0) {
    return "approximate";
  }

  const hasLiveOnlyEvidence = evidence.some((item) => item.metadata?.archivedRetrieval !== true);
  return hasLiveOnlyEvidence ? "approximate" : "exact";
}

function createFallbackCalibrationSnapshot(): CalibrationSnapshot {
  return {
    id: "evaluation-fallback-calibration",
    createdAt: new Date(0).toISOString(),
    trainingWindow: "all_time",
    judgeWeights: {},
    baseRateParams: {},
    marketPriorParams: {},
    calibrationParams: {
      method: "identity",
    },
    onlineLearningParams: {
      enabled: false,
    },
    metrics: {},
    weightRegime: "cold_start",
    resolvedOutcomeCount: 0,
    approved: false,
  };
}

function sourceConfigurationForBaseline(
  baseline: EvaluationRun["baselines"][number],
): string {
  switch (baseline) {
    case "base_rate_only":
      return "base_rate_only";
    case "polymarket_only":
      return "polymarket_only";
    case "model_without_polymarket":
      return "without_polymarket";
    case "model_with_polymarket":
      return "with_polymarket";
  }
}

function isModelBaseline(
  baseline: EvaluationRun["baselines"][number],
): baseline is "model_without_polymarket" | "model_with_polymarket" {
  return baseline === "model_without_polymarket" || baseline === "model_with_polymarket";
}

function predictionReferenceKey(benchmarkMarketId: string, cutoffAt: string): string {
  return `${benchmarkMarketId}:${cutoffAt}`;
}

function summarizePairs(pairs: EvaluationPair[]) {
  if (pairs.length === 0) {
    // Nothing was scored, so there are no scores: a 0 would read as a perfect forecast.
    return { sampleSize: 0 };
  }

  return {
    brierScore: brierScore(pairs),
    logLoss: logLoss(pairs),
    averageAbsoluteError: averageAbsoluteError(pairs),
    expectedCalibrationError: expectedCalibrationError(pairs),
    winRateVsPolymarket: winRateVsReference(pairs),
    sampleSize: pairs.length,
  };
}

/**
 * Baselines skip different market-cutoff pairs (missing snapshots, provider failures), so
 * per-baseline averages are over different samples. The paired view restricts every
 * baseline to the pairs all of them scored, which is the comparison that is fair.
 */
function summarizePairedBaselines(
  baselines: EvaluationRun["baselines"],
  predictions: EvaluationPredictionInput[],
  pairs: EvaluationPair[],
) {
  const keysByBaseline = new Map<string, Set<string>>();

  predictions.forEach((prediction) => {
    const keys = keysByBaseline.get(prediction.baseline) ?? new Set<string>();
    keys.add(predictionReferenceKey(prediction.benchmarkMarketId, prediction.cutoffAt));
    keysByBaseline.set(prediction.baseline, keys);
  });

  const sharedKeys = [...(keysByBaseline.get(baselines[0] ?? "") ?? new Set<string>())].filter((key) =>
    baselines.every((baseline) => keysByBaseline.get(baseline)?.has(key)),
  );
  const shared = new Set(sharedKeys);

  const sharedPairsFor = (baseline: string) =>
    pairs.flatMap((pair, index) => {
      const prediction = predictions[index];
      return pair.baseline === baseline &&
        prediction !== undefined &&
        shared.has(predictionReferenceKey(prediction.benchmarkMarketId, prediction.cutoffAt))
        ? [{ ...pair, groupId: prediction.benchmarkMarketId }]
        : [];
    });

  return {
    sampleSize: shared.size,
    byBaseline: Object.fromEntries(
      baselines.map((baseline) => [baseline, summarizePairs(sharedPairsFor(baseline))]),
    ),
    // Each baseline's Brier score minus Polymarket's on the same pairs, with an interval
    // from resampling markets: a market's horizons are not independent forecasts.
    vsPolymarket: Object.fromEntries(
      baselines
        .filter((baseline) => baseline !== "polymarket_only")
        .map((baseline) => [baseline, clusteredBrierDifference(sharedPairsFor(baseline))]),
    ),
  };
}

export async function collectReplayEvidence(args: {
  env: AppEnv;
  event: EventRecord;
  cutoffAt: string;
  providers: EvidenceProvider[];
  evidenceCacheStore: EvidenceCacheStore;
  sharedEvidenceStore?: Map<string, EvidenceItem[]>;
  warningCollector?: (warning: string) => void;
}): Promise<EvidenceItem[]> {
  const rawItems = (
    await Promise.all(
      args.providers.map(async (provider) => {
        try {
          let providerItems: EvidenceItem[];

          if (args.env.CASSANDRA_ADAPTER_MODE === "fixture") {
            providerItems = await provider.collect({
              event: args.event,
              evaluationTime: args.cutoffAt,
              mode: args.env.CASSANDRA_ADAPTER_MODE,
            });
          } else {
            const sharedCacheKey = `${args.event.id}:${provider.name}`;
            const sharedEvidence = args.sharedEvidenceStore?.get(sharedCacheKey);

            if (sharedEvidence) {
              providerItems = sharedEvidence;
            } else {
              const cacheKey = buildReplayEvidenceCacheKey({
                eventId: args.event.id,
                question: args.event.question,
                cutoffAt: args.cutoffAt,
                providerName: provider.name,
              });
              const cached = await args.evidenceCacheStore.get(cacheKey);

              if (cached) {
                providerItems = JSON.parse(cached) as EvidenceItem[];
              } else {
                providerItems = await provider.collect({
                  event: args.event,
                  evaluationTime: args.cutoffAt,
                  mode: args.env.CASSANDRA_ADAPTER_MODE,
                });

                await args.evidenceCacheStore.set(
                  cacheKey,
                  JSON.stringify(providerItems),
                  DEFAULT_EVIDENCE_CACHE_TTL_SECONDS,
                );
              }

              args.sharedEvidenceStore?.set(sharedCacheKey, providerItems);
            }
          }

          return filterEvidenceForCutoff(providerItems, args.cutoffAt).map((item) => ({
            ...item,
            eventId: args.event.id,
          }));
        } catch (error) {
          args.warningCollector?.(
            `Provider ${provider.name} failed for ${args.event.id} at ${args.cutoffAt}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        }
      }),
    )
  ).flat();

  return normalizeEvidenceItems(rawItems).map((item) => ({
    ...item,
    eventId: args.event.id,
  }));
}

export function buildHistoricalPolymarketEvidenceItem(args: {
  event: EventRecord;
  market: BenchmarkMarket;
  snapshot: BenchmarkPriceSnapshotRecord;
}): EvidenceItem {
  return {
    id: `historical-polymarket:${args.snapshot.id}`,
    eventId: args.event.id,
    sourceFamily: "prediction_market",
    sourceType: "quote_snapshot",
    title: `${args.market.title} (historical Polymarket snapshot)`,
    url: args.market.marketUrl,
    publisher: "Polymarket benchmark snapshot",
    publishedAt: new Date(args.snapshot.cutoffAt).toISOString(),
    retrievedAt: new Date(args.snapshot.createdAt).toISOString(),
    summary: `Historical Polymarket probability at cutoff: ${args.snapshot.probability}`,
    rawText: null,
    entities: args.event.entities,
    claims: [args.market.resolutionCriteria],
    stance: "unknown",
    qualitySignals: {},
    metadata: {
      archivedRetrieval: true,
      benchmarkPriceSnapshotId: args.snapshot.id,
      benchmarkSnapshotSource: args.snapshot.source,
      // Snapshot liquidity/volume are the market's end-of-life values (often 0 once
      // resolved), not values at the cutoff. Exposing them as liquidity would both leak
      // post-cutoff information and zero out trust in the price, so the prior treats
      // liquidity as unknown.
      finalLiquidity: args.snapshot.liquidity,
      finalVolume: args.snapshot.volume,
      price: args.snapshot.probability,
      probability: args.snapshot.probability,
      provider: "benchmarkPolymarket",
    },
  };
}

async function defaultEvaluateModelBaseline(
  args: EvaluateModelBaselineArgs,
): Promise<ModelBaselineEvaluationResult> {
  const replayWarnings: string[] = [];
  const evidence = await collectReplayEvidence({
    env: args.env,
    event: args.event,
    cutoffAt: args.cutoff.cutoffAt,
    providers: providersForBaseline(args.baseline, args.evidenceProviders),
    evidenceCacheStore: args.evidenceCacheStore,
    sharedEvidenceStore: args.sharedEvidenceStore,
    warningCollector: (warning) => replayWarnings.push(warning),
  });
  const replayEvidence =
    args.baseline === "model_with_polymarket" && args.polymarketSnapshot
      ? [
          ...evidence,
          buildHistoricalPolymarketEvidenceItem({
            event: args.event,
            market: args.market,
            snapshot: args.polymarketSnapshot,
          }),
        ]
      : evidence;

  assertNoPolymarketLeak(args.baseline, replayEvidence);

  const replayFidelity = inferReplayFidelity(replayEvidence);
  const liveCoverage =
    args.env.CASSANDRA_ADAPTER_MODE === "live"
      ? assessLiveCoverageForEvidence(args.event, replayEvidence)
      : null;
  const verdictTrace =
    liveCoverage && !liveCoverage.hasEnoughCitationCoverage
      ? await evaluatePriorOnlyForecast({
          env: args.env,
          event: args.event,
          evidence: replayEvidence,
          evaluationTime: args.cutoff.cutoffAt,
          calibrationSnapshot: args.calibrationSnapshot,
          judgeClient: args.judgeClient,
        })
      : await evaluateEventForecast({
          env: args.env,
          event: args.event,
          evaluationTime: args.cutoff.cutoffAt,
          evidence: replayEvidence,
          calibrationSnapshot: args.calibrationSnapshot,
          judgeCacheStore: args.judgeCacheStore,
          judgeClient: args.judgeClient,
        });

  return {
    probability: verdictTrace.finalProbability,
    replayFidelity,
    leakageWarnings: replayWarnings,
    calibration: {
      preCalibrationProbability: verdictTrace.preCalibrationProbability ?? null,
      priorProbability: verdictTrace.priorProbability,
      status: verdictTrace.status,
      calibrationVersion: verdictTrace.calibrationVersion,
      judgeOpinions: verdictTrace.judgeOpinions.map((opinion) => ({
        judgeName: opinion.judgeName,
        logBayesFactor: opinion.logBayesFactor,
        hadEvidence: opinion.evidenceIds.length > 0,
      })),
    },
  };
}

function selectBenchmarkMarkets(
  benchmarkMarkets: BenchmarkMarket[],
  requestedMarketIds: string[] | undefined,
): BenchmarkMarket[] {
  const selectedMarkets = requestedMarketIds?.length
    ? benchmarkMarkets.filter((market) => requestedMarketIds.includes(market.id))
    : benchmarkMarkets;

  if (requestedMarketIds?.length) {
    const selectedMarketIds = new Set(selectedMarkets.map((market) => market.id));
    const missingMarketIds = requestedMarketIds.filter((marketId) => !selectedMarketIds.has(marketId));

    if (missingMarketIds.length > 0) {
      throw new Error(`Benchmark markets not found: ${missingMarketIds.join(", ")}`);
    }
  }

  if (selectedMarkets.length === 0) {
    throw new Error("No benchmark markets available for evaluation");
  }

  return selectedMarkets;
}

/** Checks a run request against the stored benchmark set and says what it will cover. */
export async function planEvaluationRun(args: {
  pool: Pool;
  input: RunHistoricalEvaluationInput;
  listBenchmarkMarkets?: (pool: Pool, benchmarkSetId: string) => Promise<BenchmarkMarket[]>;
}): Promise<{ baselines: EvaluationRun["baselines"]; cutoffs: string[]; totalMarkets: number; benchmarkMarketIds: string[] }> {
  const benchmarkMarkets = await (args.listBenchmarkMarkets ?? loadBenchmarkMarkets)(
    args.pool,
    args.input.benchmarkSetId,
  );

  return {
    baselines: args.input.baselines ?? [...DEFAULT_BASELINES],
    cutoffs: REPLAY_HORIZONS.map(({ horizon }) => horizon),
    totalMarkets: selectBenchmarkMarkets(benchmarkMarkets, args.input.benchmarkMarketIds).length,
    benchmarkMarketIds: selectBenchmarkMarkets(benchmarkMarkets, args.input.benchmarkMarketIds).map((market) => market.id),
  };
}

function predictionKey(prediction: Pick<EvaluationPredictionInput, "benchmarkMarketId" | "cutoffAt" | "baseline">) {
  return `${prediction.benchmarkMarketId}|${new Date(prediction.cutoffAt).toISOString()}|${prediction.baseline}`;
}

/**
 * Replays the selected markets at every cutoff for every baseline, one market at a time.
 * Forecasts in `existingPredictions` are not made again, which is what lets a run resume.
 */
async function replayBenchmarkMarkets(
  args: ReplayDependencies & {
    input: RunHistoricalEvaluationInput;
    existingPredictions?: EvaluationPredictionInput[];
    initialLeakageWarnings?: string[];
    onMarketCompleted?: MarketCompletedHook;
  },
): Promise<{
  baselines: EvaluationRun["baselines"];
  selectedMarkets: BenchmarkMarket[];
  predictions: EvaluationPredictionInput[];
  replayFidelity: EvaluationRun["replayFidelity"];
  leakageWarnings: string[];
}> {
  assertLiveEvaluationMode(args.env);
  const baselines = args.input.baselines ?? [...DEFAULT_BASELINES];
  const listBenchmarks = args.listBenchmarkMarkets ??
    ((pool: Pool, setId: string) => loadBenchmarkMarkets(pool, setId, Boolean(args.input.benchmarkMarketIds)));
  const listSnapshots = args.listPriceSnapshotsForBenchmark ?? loadPriceSnapshotsForBenchmark;
  const getCalibrationSnapshot = args.getCalibrationSnapshot ?? getActiveCalibrationSnapshot;
  const evaluateModelBaseline = args.evaluateModelBaseline ?? defaultEvaluateModelBaseline;
  const benchmarkMarkets = await listBenchmarks(args.pool, args.input.benchmarkSetId);
  const selectedMarkets = selectBenchmarkMarkets(benchmarkMarkets, args.input.benchmarkMarketIds);

  if (
    baselines.some((baseline) => isModelBaseline(baseline)) &&
    !args.evidenceProviders &&
    !args.evaluateModelBaseline
  ) {
    assertLiveAuthoritativeSearchProviderConfigured(args.env);
  }

  const calibrationSnapshot =
    (await getCalibrationSnapshot(args.pool)) ?? createFallbackCalibrationSnapshot();
  const evidenceProviders =
    args.evidenceProviders ?? createDefaultJudgmentEvidenceProviders(args.env);
  const evidenceCacheStore = args.evidenceCacheStore ?? new InMemoryEvidenceCacheStore();
  const judgeCacheStore = args.judgeCacheStore ?? new InMemoryJudgeCacheStore();
  const sharedEvidenceStore = new Map<string, EvidenceItem[]>();
  const alreadyPredicted = new Set((args.existingPredictions ?? []).map(predictionKey));
  const predictions: EvaluationPredictionInput[] = [];
  const leakageWarnings = new Set<string>(args.initialLeakageWarnings ?? []);
  // A resumed run cannot know how faithful its earlier markets were, so it starts as approximate.
  let replayFidelity: EvaluationRun["replayFidelity"] =
    alreadyPredicted.size > 0 ? "approximate" : "exact";
  let completedMarkets = 0;

  for (const market of selectedMarkets) {
    const marketPredictions: EvaluationPredictionInput[] = [];
    const snapshots = await listSnapshots(args.pool, market.id);
    const cutoffs = buildMarketReplayCutoffs(market);
    const evaluatedHorizons = new Set(cutoffs.map((cutoff) => cutoff.horizon));
    const skippedHorizons = REPLAY_HORIZONS.map(({ horizon }) => horizon).filter(
      (horizon) => !evaluatedHorizons.has(horizon),
    );

    if (skippedHorizons.length > 0) {
      leakageWarnings.add(
        `Skipped horizons ${skippedHorizons.join(", ")} for ${market.id}: the market resolved before those cutoffs`,
      );
    }
    const event = baselines.some((baseline) => isModelBaseline(baseline))
      ? buildReplayEventRecord(market)
      : null;

    for (const cutoff of cutoffs) {
      const polymarketSnapshot = selectPolymarketSnapshotAtCutoff(snapshots, cutoff.cutoffAt);
      const polymarketProbability = polymarketSnapshot?.probability ?? 0.5;

      for (const baseline of baselines) {
        if (alreadyPredicted.has(predictionKey({ benchmarkMarketId: market.id, cutoffAt: cutoff.cutoffAt, baseline }))) {
          continue;
        }

        if (
          (baseline === "polymarket_only" || baseline === "model_with_polymarket") &&
          !polymarketSnapshot
        ) {
          replayFidelity = "approximate";
          leakageWarnings.add(
            `Skipped ${baseline} for ${market.id} at ${cutoff.cutoffAt}: no benchmark Polymarket price snapshot available`,
          );
          continue;
        }

        let predictedProbability: number;
        let metadata: Record<string, unknown> = {};

        if (baseline === "base_rate_only") {
          // A reference class with history gives the base rate. Benchmark markets have
          // none, so theirs is how such markets had resolved by the cutoff.
          predictedProbability = event?.referenceClass
            ? computeBaseRateOnlyProbability({ referenceClass: event.referenceClass, calibrationSnapshot })
            : computeBenchmarkBaseRate({ market, markets: benchmarkMarkets, cutoffAt: cutoff.cutoffAt });
        } else if (baseline === "polymarket_only") {
          predictedProbability = polymarketProbability;
          metadata = polymarketSnapshot
            ? {
                benchmarkPriceSnapshotId: polymarketSnapshot.id,
                benchmarkSnapshotSource: polymarketSnapshot.source,
              }
            : {};
        } else {
          if (!event) {
            throw new Error(`Missing replay event for baseline ${baseline}`);
          }

          try {
            const evaluated = await evaluateModelBaseline({
              pool: args.pool,
              env: args.env,
              event,
              market,
              cutoff,
              baseline,
              polymarketSnapshot,
              calibrationSnapshot,
              evidenceProviders,
              evidenceCacheStore,
              judgeCacheStore,
              sharedEvidenceStore,
              judgeClient: args.judgeClient,
            });
            predictedProbability = evaluated.probability;
            metadata = {
              replayFidelity: evaluated.replayFidelity,
              ...(evaluated.calibration ? { calibration: evaluated.calibration } : {}),
            };

            if (evaluated.replayFidelity === "approximate") {
              replayFidelity = "approximate";
            }

            for (const warning of evaluated.leakageWarnings ?? []) {
              leakageWarnings.add(warning);
            }
          } catch (error) {
            replayFidelity = "approximate";
            leakageWarnings.add(
              `Skipped ${baseline} for ${market.id} at ${cutoff.cutoffAt}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            continue;
          }
        }

        marketPredictions.push({
          benchmarkMarketId: market.id,
          baseline,
          cutoffAt: cutoff.cutoffAt,
          predictedProbability,
          outcome: market.resolvedValue,
          theme: market.theme,
          horizon: cutoff.horizon,
          sourceConfiguration: sourceConfigurationForBaseline(baseline),
          metadata,
        });
      }
    }

    completedMarkets += 1;
    await args.onMarketCompleted?.({
      market,
      predictions: marketPredictions,
      completedMarkets,
      totalMarkets: selectedMarkets.length,
      replayFidelity,
      leakageWarnings: [...leakageWarnings],
    });
    predictions.push(...marketPredictions);
  }

  return { baselines, selectedMarkets, predictions, replayFidelity, leakageWarnings: [...leakageWarnings] };
}

/** Scores a set of predictions: per baseline, on the pairs every baseline scored, and by slice. */
export function summarizeEvaluationPredictions(args: {
  baselines: EvaluationRun["baselines"];
  predictions: EvaluationPredictionInput[];
  benchmarkCount: number;
}): Pick<EvaluationRun, "overallMetrics" | "sliceResults"> {
  const { baselines, predictions } = args;
  const polymarketReferences = new Map<string, number>();

  for (const prediction of predictions) {
    if (prediction.baseline === "polymarket_only") {
      polymarketReferences.set(
        predictionReferenceKey(prediction.benchmarkMarketId, prediction.cutoffAt),
        prediction.predictedProbability,
      );
    }
  }

  const pairs: EvaluationPair[] = predictions.map((prediction) => ({
    predicted: prediction.predictedProbability,
    outcome: prediction.outcome ? 1 : 0,
    baseline: prediction.baseline,
    theme: prediction.theme,
    horizon: prediction.horizon,
    sourceConfiguration: prediction.sourceConfiguration,
    referencePredicted: polymarketReferences.get(
      predictionReferenceKey(prediction.benchmarkMarketId, prediction.cutoffAt),
    ),
  }));

  return {
    overallMetrics: {
      benchmarkCount: args.benchmarkCount,
      predictionCount: predictions.length,
      byBaseline: Object.fromEntries(
        baselines.map((baseline) => [
          baseline,
          summarizePairs(pairs.filter((pair) => pair.baseline === baseline)),
        ]),
      ),
      paired: summarizePairedBaselines(baselines, predictions, pairs),
    },
    sliceResults: baselines.flatMap((baseline) => [
      ...sliceMetrics(pairs, { key: "theme", baseline }),
      ...sliceMetrics(pairs, { key: "horizon", baseline }),
      ...sliceMetrics(pairs, { key: "sourceConfiguration", baseline }),
    ]),
  };
}

/** Runs a whole evaluation in one call and stores it when it is done. */
export async function runHistoricalEvaluation(
  args: RunHistoricalEvaluationArgs,
): Promise<EvaluationRun> {
  const persistEvaluationResult =
    args.persistEvaluationRunResult ?? persistEvaluationRunWithPredictions;
  const replay = await replayBenchmarkMarkets(args);

  return persistEvaluationResult(args.pool, {
    run: {
      benchmarkSetId: args.input.benchmarkSetId,
      cutoffs: REPLAY_HORIZONS.map(({ horizon }) => horizon),
      baselines: replay.baselines,
      ...summarizeEvaluationPredictions({
        baselines: replay.baselines,
        predictions: replay.predictions,
        benchmarkCount: replay.selectedMarkets.length,
      }),
      replayFidelity: replay.replayFidelity,
      leakageWarnings: replay.leakageWarnings,
    },
    predictions: replay.predictions,
  });
}

/**
 * Works through a queued run. Each market's forecasts are stored as soon as the market is
 * done, so a run that fails or is interrupted keeps what it paid for, and running it again
 * continues from there instead of starting over.
 */
export async function executeEvaluationRun(
  args: ReplayDependencies & {
    runId: string;
    onMarketCompleted?: MarketCompletedHook;
  },
): Promise<void> {
  const stored = await getEvaluationRunRequest(args.pool, args.runId);

  if (!stored) {
    throw new Error(`Evaluation run not found or not queued: ${args.runId}`);
  }

  await markEvaluationRunRunning(args.pool, args.runId);

  try {
    const existingPredictions = await listEvaluationPredictionsForRun(args.pool, args.runId);
    const replay = await replayBenchmarkMarkets({
      ...args,
      input: stored.request,
      existingPredictions,
      initialLeakageWarnings: stored.leakageWarnings,
      onMarketCompleted: async (completed) => {
        await args.onMarketCompleted?.(completed);
        await insertEvaluationPredictions(args.pool, args.runId, completed.predictions);
        await recordEvaluationRunProgress(args.pool, args.runId, completed);
      },
    });

    await completeEvaluationRun(args.pool, args.runId, {
      ...summarizeEvaluationPredictions({
        baselines: replay.baselines,
        predictions: [...existingPredictions, ...replay.predictions],
        benchmarkCount: replay.selectedMarkets.length,
      }),
      replayFidelity: replay.replayFidelity,
      leakageWarnings: replay.leakageWarnings,
    });
  } catch (error) {
    await failEvaluationRun(args.pool, args.runId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
