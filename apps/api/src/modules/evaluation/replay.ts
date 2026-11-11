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
  providersForBaseline,
  selectPolymarketSnapshotAtCutoff,
} from "./baselines.js";
import {
  averageAbsoluteError,
  brierScore,
  expectedCalibrationError,
  logLoss,
  sliceMetrics,
  winRateVsReference,
  type EvaluationPair,
} from "./metrics.js";
import { assertLiveEvaluationMode } from "./liveMode.js";
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
  polymarketSnapshot: BenchmarkPriceSnapshotRecord | null;
  calibrationSnapshot: CalibrationSnapshot;
  evidenceProviders: EvidenceProvider[];
  evidenceCacheStore: EvidenceCacheStore;
  judgeCacheStore: JudgeCacheStore;
  sharedEvidenceStore: Map<string, EvidenceItem[]>;
  judgeClient?: JudgeClient;
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

  return {
    sampleSize: shared.size,
    byBaseline: Object.fromEntries(
      baselines.map((baseline) => [
        baseline,
        summarizePairs(
          pairs.filter((pair, index) => {
            const prediction = predictions[index];
            return (
              pair.baseline === baseline &&
              prediction !== undefined &&
              shared.has(predictionReferenceKey(prediction.benchmarkMarketId, prediction.cutoffAt))
            );
          }),
        ),
      ]),
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
  };
}

export async function runHistoricalEvaluation(
  args: RunHistoricalEvaluationArgs,
): Promise<EvaluationRun> {
  assertLiveEvaluationMode(args.env);
  const baselines = args.input.baselines ?? [...DEFAULT_BASELINES];
  const listBenchmarks = args.listBenchmarkMarkets ?? loadBenchmarkMarkets;
  const listSnapshots = args.listPriceSnapshotsForBenchmark ?? loadPriceSnapshotsForBenchmark;
  const getCalibrationSnapshot = args.getCalibrationSnapshot ?? getLatestCalibrationSnapshot;
  const evaluateModelBaseline = args.evaluateModelBaseline ?? defaultEvaluateModelBaseline;
  const persistEvaluationResult =
    args.persistEvaluationRunResult ?? persistEvaluationRunWithPredictions;
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
  const predictions: EvaluationPredictionInput[] = [];
  const leakageWarnings = new Set<string>();
  let replayFidelity: EvaluationRun["replayFidelity"] = "exact";

  for (const market of selectedMarkets) {
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
              polymarketSnapshot,
              calibrationSnapshot,
              evidenceProviders,
              evidenceCacheStore,
              judgeCacheStore,
              sharedEvidenceStore,
              judgeClient: args.judgeClient,
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
    paired: summarizePairedBaselines(baselines, predictions, pairs),
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
