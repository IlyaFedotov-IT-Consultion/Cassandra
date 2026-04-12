import type {
  BenchmarkMarket,
  CalibrationSnapshot,
  EvidenceItem,
  EventInput,
  EvaluationRun,
} from "@cassandra/shared";
import type { Pool } from "pg";

import type { AppEnv } from "../../config/env.js";
import { getLatestCalibrationSnapshot } from "../backtests/repository.js";
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
  createDefaultEvidenceProviders as createDefaultJudgmentEvidenceProviders,
  evaluateEventForecast,
} from "../judgments/service.js";
import {
  assertNoPolymarketLeak,
  computeBaseRateOnlyProbability,
  providersForBaseline,
  selectPolymarketSnapshotAtCutoff,
} from "./baselines.js";
import {
  averageAbsoluteError,
  brierScore,
  logLoss,
  sliceMetrics,
  winRateVsReference,
  type EvaluationPair,
} from "./metrics.js";
import {
  createEvaluationRunWithPredictions as persistEvaluationRunWithPredictions,
  listBenchmarkMarkets as loadBenchmarkMarkets,
  listPriceSnapshotsForBenchmark as loadPriceSnapshotsForBenchmark,
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

export interface ModelBaselineEvaluationResult {
  probability: number;
  replayFidelity: EvaluationRun["replayFidelity"];
  leakageWarnings?: string[];
}

export interface EvaluateModelBaselineArgs {
  pool: Pool;
  env: AppEnv;
  event: EventRecord;
  market: BenchmarkMarket;
  cutoff: ReplayCutoff;
  baseline: "model_without_polymarket" | "model_with_polymarket";
  calibrationSnapshot: CalibrationSnapshot;
  evidenceProviders: EvidenceProvider[];
  evidenceCacheStore: EvidenceCacheStore;
  judgeCacheStore: JudgeCacheStore;
}

export interface RunHistoricalEvaluationArgs {
  pool: Pool;
  env: AppEnv;
  input: RunHistoricalEvaluationInput;
  evidenceProviders?: EvidenceProvider[];
  evidenceCacheStore?: EvidenceCacheStore;
  judgeCacheStore?: JudgeCacheStore;
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

export function buildReplayCutoffs(resolvedAt: string): ReplayCutoff[] {
  const resolvedMillis = new Date(resolvedAt).getTime();

  return REPLAY_HORIZONS.map(({ horizon, hours }) => ({
    horizon,
    cutoffAt: new Date(resolvedMillis - hours * 60 * 60 * 1000).toISOString(),
  }));
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
    deadline: market.resolvedAt,
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
  return {
    brierScore: brierScore(pairs),
    logLoss: logLoss(pairs),
    averageAbsoluteError: averageAbsoluteError(pairs),
    winRateVsPolymarket: winRateVsReference(pairs),
    sampleSize: pairs.length,
  };
}

export async function collectReplayEvidence(args: {
  env: AppEnv;
  event: EventRecord;
  cutoffAt: string;
  providers: EvidenceProvider[];
  evidenceCacheStore: EvidenceCacheStore;
}): Promise<EvidenceItem[]> {
  const rawItems: EvidenceItem[] = [];

  for (const provider of args.providers) {
    let providerItems: EvidenceItem[];

    if (args.env.CASSANDRA_ADAPTER_MODE === "fixture") {
      providerItems = await provider.collect({
        event: args.event,
        evaluationTime: args.cutoffAt,
        mode: args.env.CASSANDRA_ADAPTER_MODE,
      });
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
    }

    rawItems.push(
      ...filterEvidenceForCutoff(providerItems, args.cutoffAt).map((item) => ({
        ...item,
        eventId: args.event.id,
      })),
    );
  }

  return normalizeEvidenceItems(rawItems).map((item) => ({
    ...item,
    eventId: args.event.id,
  }));
}

async function defaultEvaluateModelBaseline(
  args: EvaluateModelBaselineArgs,
): Promise<ModelBaselineEvaluationResult> {
  const evidence = await collectReplayEvidence({
    env: args.env,
    event: args.event,
    cutoffAt: args.cutoff.cutoffAt,
    providers: providersForBaseline(args.baseline, args.evidenceProviders),
    evidenceCacheStore: args.evidenceCacheStore,
  });

  assertNoPolymarketLeak(args.baseline, evidence);

  const replayFidelity = inferReplayFidelity(evidence);
  const verdictTrace = await evaluateEventForecast({
    env: args.env,
    event: args.event,
    evaluationTime: args.cutoff.cutoffAt,
    evidence,
    calibrationSnapshot: args.calibrationSnapshot,
    judgeCacheStore: args.judgeCacheStore,
  });

  return {
    probability: verdictTrace.finalProbability,
    replayFidelity,
    leakageWarnings: [],
  };
}

export async function runHistoricalEvaluation(
  args: RunHistoricalEvaluationArgs,
): Promise<EvaluationRun> {
  const listBenchmarks = args.listBenchmarkMarkets ?? loadBenchmarkMarkets;
  const listSnapshots = args.listPriceSnapshotsForBenchmark ?? loadPriceSnapshotsForBenchmark;
  const getCalibrationSnapshot = args.getCalibrationSnapshot ?? getLatestCalibrationSnapshot;
  const evaluateModelBaseline = args.evaluateModelBaseline ?? defaultEvaluateModelBaseline;
  const persistEvaluationResult =
    args.persistEvaluationRunResult ?? persistEvaluationRunWithPredictions;
  const baselines = args.input.baselines ?? [...DEFAULT_BASELINES];
  const benchmarkMarkets = await listBenchmarks(args.pool, args.input.benchmarkSetId);
  const requestedMarketIds = args.input.benchmarkMarketIds;
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

  const calibrationSnapshot =
    (await getCalibrationSnapshot(args.pool)) ?? createFallbackCalibrationSnapshot();
  const evidenceProviders =
    args.evidenceProviders ?? createDefaultJudgmentEvidenceProviders(args.env);
  const evidenceCacheStore = args.evidenceCacheStore ?? new InMemoryEvidenceCacheStore();
  const judgeCacheStore = args.judgeCacheStore ?? new InMemoryJudgeCacheStore();
  const predictions: EvaluationPredictionInput[] = [];
  const leakageWarnings = new Set<string>();
  let replayFidelity: EvaluationRun["replayFidelity"] = "exact";

  for (const market of selectedMarkets) {
    const snapshots = await listSnapshots(args.pool, market.id);
    const cutoffs = buildReplayCutoffs(market.resolvedAt);
    const event = baselines.some((baseline) => isModelBaseline(baseline))
      ? buildReplayEventRecord(market)
      : null;

    for (const cutoff of cutoffs) {
      const polymarketSnapshot = selectPolymarketSnapshotAtCutoff(snapshots, cutoff.cutoffAt);
      const polymarketProbability = polymarketSnapshot?.probability ?? 0.5;

      for (const baseline of baselines) {
        let predictedProbability: number;

        if (baseline === "base_rate_only") {
          predictedProbability = computeBaseRateOnlyProbability({
            referenceClass: event?.referenceClass ?? null,
            calibrationSnapshot,
          });
        } else if (baseline === "polymarket_only") {
          predictedProbability = polymarketProbability;
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
              calibrationSnapshot,
              evidenceProviders,
              evidenceCacheStore,
              judgeCacheStore,
            });
            predictedProbability = evaluated.probability;

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

        predictions.push({
          benchmarkMarketId: market.id,
          baseline,
          cutoffAt: cutoff.cutoffAt,
          predictedProbability,
          outcome: market.resolvedValue,
          theme: market.theme,
          horizon: cutoff.horizon,
          sourceConfiguration: sourceConfigurationForBaseline(baseline),
          metadata:
            baseline === "polymarket_only" && polymarketSnapshot
              ? {
                  benchmarkPriceSnapshotId: polymarketSnapshot.id,
                  benchmarkSnapshotSource: polymarketSnapshot.source,
                }
              : {},
        });
      }
    }
  }

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
  const overallMetrics = {
    benchmarkCount: selectedMarkets.length,
    predictionCount: predictions.length,
    byBaseline: Object.fromEntries(
      baselines.map((baseline) => [
        baseline,
        summarizePairs(pairs.filter((pair) => pair.baseline === baseline)),
      ]),
    ),
  };
  const sliceResults = baselines.flatMap((baseline) => [
    ...sliceMetrics(pairs, {
      key: "theme",
      baseline,
    }),
    ...sliceMetrics(pairs, {
      key: "horizon",
      baseline,
    }),
    ...sliceMetrics(pairs, {
      key: "sourceConfiguration",
      baseline,
    }),
  ]);
  return persistEvaluationResult(args.pool, {
    run: {
      benchmarkSetId: args.input.benchmarkSetId,
      cutoffs: REPLAY_HORIZONS.map(({ horizon }) => horizon),
      baselines,
      overallMetrics,
      sliceResults,
      replayFidelity,
      leakageWarnings: [...leakageWarnings],
    },
    predictions,
  });
}
