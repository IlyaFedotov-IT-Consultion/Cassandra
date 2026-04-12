import { describe, expect, it } from "vitest";

import type { CalibrationSnapshot, EvidenceItem } from "@cassandra/shared";
import type { EvidenceProvider } from "../src/modules/evidence/types.js";
import {
  assertNoPolymarketLeak,
  computeBaseRateOnlyProbability,
  providersForBaseline,
  selectPolymarketSnapshotAtCutoff,
} from "../src/modules/evaluation/baselines.js";
import type { BenchmarkPriceSnapshotRecord } from "../src/modules/evaluation/repository.js";

const calibrationSnapshot: CalibrationSnapshot = {
  id: "snapshot-1",
  createdAt: "2026-01-01T00:00:00Z",
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

describe("evaluation baselines", () => {
  it("filters Polymarket-family providers for model_without_polymarket", () => {
    const providers = [
      { name: "perplexity", collect: async () => [] },
      { name: "marketProvider", collect: async () => [] },
      { name: "polymarketGamma", collect: async () => [] },
      { name: "polymarketClob", collect: async () => [] },
    ] satisfies EvidenceProvider[];

    const filtered = providersForBaseline("model_without_polymarket", providers);

    expect(filtered.map((provider) => provider.name)).toEqual(["perplexity", "marketProvider"]);
  });

  it("filters live Polymarket providers for model_with_polymarket replay", () => {
    const providers = [
      { name: "officialSearch", collect: async () => [] },
      { name: "web", collect: async () => [] },
      { name: "polymarketGamma", collect: async () => [] },
      { name: "polymarketClob", collect: async () => [] },
    ] satisfies EvidenceProvider[];

    const filtered = providersForBaseline("model_with_polymarket", providers);

    expect(filtered.map((provider) => provider.name)).toEqual(["officialSearch", "web"]);
  });

  it("fails closed when Polymarket evidence leaks into model_without_polymarket", () => {
    const leakedEvidence: EvidenceItem[] = [
      {
        id: "evidence-1",
        eventId: "event-1",
        sourceFamily: "prediction_market",
        sourceType: "polymarket_market",
        title: "Polymarket market",
        url: "https://polymarket.com/event/example",
        publisher: "Polymarket",
        publishedAt: "2026-11-30T00:00:00Z",
        retrievedAt: "2026-11-30T00:05:00Z",
        summary: "Example market",
        rawText: null,
        entities: [],
        claims: [],
        stance: "unknown",
        qualitySignals: {},
        metadata: {
          provider: "polymarketGamma",
        },
      },
    ];

    expect(() =>
      assertNoPolymarketLeak("model_without_polymarket", leakedEvidence),
    ).toThrow(/polymarket/i);
  });

  it("selects the latest Polymarket snapshot at or before the cutoff", () => {
    const snapshots: BenchmarkPriceSnapshotRecord[] = [
      {
        id: "snapshot-1",
        benchmarkMarketId: "market-1",
        cutoffAt: "2026-11-01T00:00:00Z",
        probability: 0.42,
        volume: 1000,
        liquidity: 500,
        source: "polymarket",
        createdAt: "2026-11-01T00:01:00Z",
      },
      {
        id: "snapshot-2",
        benchmarkMarketId: "market-1",
        cutoffAt: "2026-11-24T18:00:00Z",
        probability: 0.61,
        volume: 2000,
        liquidity: 1200,
        source: "polymarket",
        createdAt: "2026-11-24T18:01:00Z",
      },
      {
        id: "snapshot-3",
        benchmarkMarketId: "market-1",
        cutoffAt: "2026-12-02T00:00:00Z",
        probability: 0.73,
        volume: 2500,
        liquidity: 1500,
        source: "polymarket",
        createdAt: "2026-12-02T00:01:00Z",
      },
      {
        id: "snapshot-4",
        benchmarkMarketId: "market-1",
        cutoffAt: "2026-11-24T20:00:00Z",
        probability: 0.91,
        volume: 5000,
        liquidity: 2000,
        source: "manual_benchmark",
        createdAt: "2026-11-24T20:01:00Z",
      },
    ];

    expect(selectPolymarketSnapshotAtCutoff(snapshots, "2026-11-25T00:00:00Z")).toEqual(
      snapshots[1],
    );
    expect(selectPolymarketSnapshotAtCutoff(snapshots, "2026-10-01T00:00:00Z")).toBeNull();
  });

  it("computes base-rate-only probabilities from calibration historical counts", () => {
    const probability = computeBaseRateOnlyProbability({
      referenceClass: "product_launch",
      calibrationSnapshot: {
        ...calibrationSnapshot,
        baseRateParams: {
          minimumSample: 20,
          historicalCounts: {
            product_launch: {
              successes: 9,
              total: 10,
            },
          },
        },
      },
    });

    expect(probability).toBeCloseTo(10 / 12, 8);
  });

  it("falls back to 0.5 when no historical counts are available", () => {
    expect(
      computeBaseRateOnlyProbability({
        referenceClass: "product_launch",
        calibrationSnapshot,
      }),
    ).toBe(0.5);
  });
});
