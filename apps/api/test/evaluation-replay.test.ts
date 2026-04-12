import { describe, expect, it } from "vitest";

import type { BenchmarkMarket, CalibrationSnapshot, EvidenceItem } from "@cassandra/shared";
import { getEnv } from "../src/config/env.js";
import type { BenchmarkPriceSnapshotRecord } from "../src/modules/evaluation/repository.js";
import {
  buildReplayEvidenceCacheKey,
  buildReplayCutoffs,
  buildReplayEventRecord,
  buildReplayEventInput,
  collectReplayEvidence,
  filterEvidenceForCutoff,
  inferReplayFidelity,
  runHistoricalEvaluation,
} from "../src/modules/evaluation/replay.js";
import { InMemoryEvidenceCacheStore } from "../src/modules/evidence/cache.js";

const benchmarkMarket: BenchmarkMarket = {
  id: "market-1",
  benchmarkSetId: "benchmark-set-1",
  title: "Will Example Corp launch Product X by 2026-12-31?",
  resolutionCriteria: "Official launch announcement by deadline.",
  theme: "technology",
  volume: 100000,
  liquidity: 25000,
  resolvedAt: "2026-12-31T12:00:00Z",
  resolvedValue: true,
  marketUrl: "https://polymarket.com/event/example-product-x",
};

describe("evaluation replay", () => {
  it("builds the planned historical replay cutoffs", () => {
    expect(buildReplayCutoffs(benchmarkMarket.resolvedAt)).toEqual([
      {
        horizon: "30d",
        cutoffAt: "2026-12-01T12:00:00.000Z",
      },
      {
        horizon: "7d",
        cutoffAt: "2026-12-24T12:00:00.000Z",
      },
      {
        horizon: "1d",
        cutoffAt: "2026-12-30T12:00:00.000Z",
      },
      {
        horizon: "6h",
        cutoffAt: "2026-12-31T06:00:00.000Z",
      },
    ]);
  });

  it("reconstructs event inputs from benchmark markets", () => {
    expect(buildReplayEventInput(benchmarkMarket)).toEqual({
      question: benchmarkMarket.title,
      resolutionCriteria: benchmarkMarket.resolutionCriteria,
      deadline: benchmarkMarket.resolvedAt,
      entities: ["Example Corp launch Product X"],
      referenceClass: null,
      marketSymbols: [],
      polymarketMarketId: benchmarkMarket.id,
    });
  });

  it("uses replay-specific cache keys for duplicate-title benchmark markets", () => {
    expect(
      buildReplayEvidenceCacheKey({
        eventId: "replay-market-1",
        question: benchmarkMarket.title,
        cutoffAt: "2026-12-24T12:00:00Z",
        providerName: "perplexity",
      }),
    ).not.toBe(
      buildReplayEvidenceCacheKey({
        eventId: "replay-market-2",
        question: benchmarkMarket.title,
        cutoffAt: "2026-12-24T12:00:00Z",
        providerName: "perplexity",
      }),
    );
  });

  it("does not reuse cached provider payloads across duplicate-title replay events", async () => {
    const eventOne = buildReplayEventRecord(benchmarkMarket);
    const eventTwo = buildReplayEventRecord({
      ...benchmarkMarket,
      id: "market-2",
    });
    const cacheStore = new InMemoryEvidenceCacheStore();
    let calls = 0;
    const provider = {
      name: "perplexity",
      async collect(input: { event: { id: string } }) {
        calls += 1;
        return [
          {
            id: `evidence-${input.event.id}`,
            eventId: input.event.id,
            sourceFamily: "llm_research" as const,
            sourceType: "perplexity_search_result" as const,
            title: `Evidence for ${input.event.id}`,
            url: `https://example.com/${input.event.id}`,
            publisher: "Example",
            publishedAt: "2026-12-20T00:00:00Z",
            retrievedAt: "2026-12-20T00:05:00Z",
            summary: `Summary for ${input.event.id}`,
            rawText: null,
            entities: [],
            claims: [],
            stance: "supports" as const,
            qualitySignals: {},
            metadata: {},
          },
        ];
      },
    };

    const first = await collectReplayEvidence({
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        CASSANDRA_ADAPTER_MODE: "live",
      }),
      event: eventOne,
      cutoffAt: "2026-12-24T12:00:00Z",
      providers: [provider],
      evidenceCacheStore: cacheStore,
    });
    const second = await collectReplayEvidence({
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        CASSANDRA_ADAPTER_MODE: "live",
      }),
      event: eventTwo,
      cutoffAt: "2026-12-24T12:00:00Z",
      providers: [provider],
      evidenceCacheStore: cacheStore,
    });

    expect(calls).toBe(2);
    expect(first[0]?.eventId).toBe("replay-market-1");
    expect(second[0]?.eventId).toBe("replay-market-2");
    expect(second[0]?.url).toContain("replay-market-2");
  });

  it("filters evidence using publishedAt rather than retrievedAt", () => {
    const evidence: EvidenceItem[] = [
      {
        id: "evidence-1",
        eventId: "event-1",
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Earlier article",
        url: "https://example.com/earlier",
        publisher: "Example",
        publishedAt: "2026-12-20T00:00:00Z",
        retrievedAt: "2026-12-29T00:00:00Z",
        summary: "Published before the cutoff.",
        rawText: null,
        entities: [],
        claims: [],
        stance: "supports",
        qualitySignals: {},
        metadata: {},
      },
      {
        id: "evidence-2",
        eventId: "event-1",
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Later article",
        url: "https://example.com/later",
        publisher: "Example",
        publishedAt: "2026-12-27T00:00:00Z",
        retrievedAt: "2026-12-24T00:00:00Z",
        summary: "Published after the cutoff.",
        rawText: null,
        entities: [],
        claims: [],
        stance: "supports",
        qualitySignals: {},
        metadata: {},
      },
    ];

    expect(
      filterEvidenceForCutoff(evidence, "2026-12-24T12:00:00Z").map((item) => item.id),
    ).toEqual(["evidence-1"]);
  });

  it("marks replay fidelity approximate when archived retrieval is missing", () => {
    const evidence: EvidenceItem[] = [
      {
        id: "evidence-1",
        eventId: "event-1",
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Archived",
        url: "https://example.com/archived",
        publisher: "Example",
        publishedAt: "2026-12-20T00:00:00Z",
        retrievedAt: "2026-12-20T00:05:00Z",
        summary: "Archived retrieval available.",
        rawText: null,
        entities: [],
        claims: [],
        stance: "supports",
        qualitySignals: {},
        metadata: {
          archivedRetrieval: true,
        },
      },
      {
        id: "evidence-2",
        eventId: "event-1",
        sourceFamily: "web",
        sourceType: "web_article",
        title: "Live only",
        url: "https://example.com/live-only",
        publisher: "Example",
        publishedAt: "2026-12-21T00:00:00Z",
        retrievedAt: "2026-12-21T00:05:00Z",
        summary: "Archived retrieval unavailable.",
        rawText: null,
        entities: [],
        claims: [],
        stance: "supports",
        qualitySignals: {},
        metadata: {
          archivedRetrieval: false,
        },
      },
    ];

    expect(inferReplayFidelity(evidence)).toBe("approximate");
    expect(inferReplayFidelity(evidence.slice(0, 1))).toBe("exact");
    expect(inferReplayFidelity([])).toBe("approximate");
  });

  it("builds, persists, and summarizes a historical evaluation run", async () => {
    const calibrationSnapshot: CalibrationSnapshot = {
      id: "snapshot-1",
      createdAt: "2026-01-01T00:00:00Z",
      trainingWindow: "all_time",
      judgeWeights: {},
      baseRateParams: {
        minimumSample: 20,
        historicalCounts: {},
      },
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

    const snapshots: BenchmarkPriceSnapshotRecord[] = [
      {
        id: "snapshot-1",
        benchmarkMarketId: benchmarkMarket.id,
        cutoffAt: "2026-11-15T12:00:00Z",
        probability: 0.41,
        volume: 1000,
        liquidity: 500,
        source: "polymarket",
        createdAt: "2026-11-15T12:01:00Z",
      },
      {
        id: "snapshot-2",
        benchmarkMarketId: benchmarkMarket.id,
        cutoffAt: "2026-12-24T12:00:00Z",
        probability: 0.61,
        volume: 1500,
        liquidity: 700,
        source: "polymarket",
        createdAt: "2026-12-24T12:01:00Z",
      },
    ];

    const persistedRuns: Array<Record<string, unknown>> = [];
    const persistedPredictions: Array<Record<string, unknown>> = [];

    const pool = {
      async query(text: string) {
        throw new Error(`Unexpected query during replay orchestration test: ${text}`);
      },
    } as never;

    const run = await runHistoricalEvaluation({
      pool,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      input: {
        benchmarkSetId: "benchmark-set-1",
      },
      listBenchmarkMarkets: async () => [benchmarkMarket],
      listPriceSnapshotsForBenchmark: async () => snapshots,
      getCalibrationSnapshot: async () => calibrationSnapshot,
      evaluateModelBaseline: async ({ baseline, cutoff, event }) => {
        expect(event).toMatchObject({
          question: benchmarkMarket.title,
          polymarketMarketId: benchmarkMarket.id,
        });

        return {
        probability:
          baseline === "model_without_polymarket"
            ? 0.56
            : cutoff.horizon === "30d"
              ? 0.64
              : 0.68,
        replayFidelity: baseline === "model_with_polymarket" ? "approximate" : "exact",
        };
      },
      persistEvaluationRunResult: async (_pool, input) => {
        persistedRuns.push(input.run as Record<string, unknown>);
        persistedPredictions.push({
          evaluationRunId: "run-1",
          predictions: input.predictions,
        });

        return {
          id: "run-1",
          ...input.run,
          createdAt: "2026-01-02T00:00:00Z",
        };
      },
    });

    expect(run).toMatchObject({
      id: "run-1",
      benchmarkSetId: "benchmark-set-1",
      cutoffs: ["30d", "7d", "1d", "6h"],
      baselines: [
        "base_rate_only",
        "polymarket_only",
        "model_without_polymarket",
        "model_with_polymarket",
      ],
      replayFidelity: "approximate",
      leakageWarnings: [],
      overallMetrics: expect.objectContaining({
        benchmarkCount: 1,
        predictionCount: 16,
        byBaseline: expect.objectContaining({
          polymarket_only: expect.objectContaining({
            sampleSize: 4,
          }),
          model_with_polymarket: expect.objectContaining({
            sampleSize: 4,
          }),
        }),
      }),
    });

    expect(run.sliceResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sliceKey: "technology",
          baseline: "model_with_polymarket",
        }),
        expect.objectContaining({
          sliceKey: "30d",
          baseline: "model_with_polymarket",
        }),
      ]),
    );

    expect(persistedRuns).toHaveLength(1);
    expect(persistedPredictions).toHaveLength(1);
    expect(persistedPredictions[0]?.evaluationRunId).toBe("run-1");
    expect((persistedPredictions[0]?.predictions as Array<Record<string, unknown>>)).toHaveLength(16);
    expect(
      (persistedPredictions[0]?.predictions as Array<Record<string, unknown>>)
        .filter((prediction) => prediction.baseline === "polymarket_only")
        .map((prediction) => ({
          horizon: prediction.horizon,
          predictedProbability: prediction.predictedProbability,
        })),
    ).toEqual([
      {
        horizon: "30d",
        predictedProbability: 0.41,
      },
      {
        horizon: "7d",
        predictedProbability: 0.61,
      },
      {
        horizon: "1d",
        predictedProbability: 0.61,
      },
      {
        horizon: "6h",
        predictedProbability: 0.61,
      },
    ]);
  });

  it("loads benchmark markets for the requested benchmark set", async () => {
    let requestedBenchmarkSetId: string | undefined;

    await runHistoricalEvaluation({
      pool: {
        async query(text: string) {
          throw new Error(`Unexpected query during benchmark set selection test: ${text}`);
        },
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        CASSANDRA_ADAPTER_MODE: "fixture",
      }),
      input: {
        benchmarkSetId: "benchmark-set-1",
        baselines: ["polymarket_only"],
      },
      listBenchmarkMarkets: (async (_pool: unknown, benchmarkSetId: string) => {
        requestedBenchmarkSetId = benchmarkSetId;
        return [benchmarkMarket];
      }) as never,
      listPriceSnapshotsForBenchmark: async () => [],
      getCalibrationSnapshot: async () => null,
      persistEvaluationRunResult: async (_pool, input) => ({
        id: "run-1",
        ...input.run,
        createdAt: "2026-01-02T00:00:00Z",
      }),
    });

    expect(requestedBenchmarkSetId).toBe("benchmark-set-1");
  });

  it("skips failing model baseline predictions instead of aborting the full run", async () => {
    const run = await runHistoricalEvaluation({
      pool: {
        async query(text: string) {
          throw new Error(`Unexpected query during skipped baseline test: ${text}`);
        },
      } as never,
      env: getEnv({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
        REDIS_URL: "redis://localhost:6379",
        CASSANDRA_ADAPTER_MODE: "live",
      }),
      input: {
        benchmarkSetId: "benchmark-set-1",
        baselines: ["base_rate_only", "model_without_polymarket"],
      },
      listBenchmarkMarkets: async () => [benchmarkMarket],
      listPriceSnapshotsForBenchmark: async () => [],
      getCalibrationSnapshot: async () => ({
        id: "snapshot-1",
        createdAt: "2026-10-01T00:00:00Z",
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
      }),
      evaluateModelBaseline: async () => {
        throw new Error("judge contract mismatch");
      },
      persistEvaluationRunResult: async (_pool, input) => ({
        id: "run-2",
        ...input.run,
        createdAt: "2026-01-02T00:00:00Z",
      }),
    });

    expect(run.overallMetrics.predictionCount).toBe(4);
    expect(run.overallMetrics.byBaseline.base_rate_only.sampleSize).toBe(4);
    expect(run.overallMetrics.byBaseline.model_without_polymarket.sampleSize).toBe(0);
    expect(run.replayFidelity).toBe("approximate");
    expect(run.leakageWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Skipped model_without_polymarket"),
        expect.stringContaining("judge contract mismatch"),
      ]),
    );
  });

  it("fails when requested benchmark market ids are missing", async () => {
    await expect(
      runHistoricalEvaluation({
        pool: {
          async query(text: string) {
            throw new Error(`Unexpected query during missing benchmark test: ${text}`);
          },
        } as never,
        env: getEnv({
          DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/cassandra",
          REDIS_URL: "redis://localhost:6379",
          CASSANDRA_ADAPTER_MODE: "fixture",
        }),
        input: {
          benchmarkSetId: "benchmark-set-1",
          benchmarkMarketIds: ["market-1", "missing-market"],
        },
        listBenchmarkMarkets: async () => [benchmarkMarket],
      }),
    ).rejects.toThrow("Benchmark markets not found: missing-market");
  });
});
