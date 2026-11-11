import { describe, expect, it } from "vitest";

import type { CalibrationSnapshot, EvidenceItem } from "@cassandra/shared";
import type { EvidenceProvider } from "../src/modules/evidence/types.js";
import {
  assertNoPolymarketLeak,
  computeBenchmarkBaseRate,
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
              total: 20,
            },
          },
        },
      },
    });

    expect(probability).toBeCloseTo(10 / 22, 8);
  });

  it("falls back to 0.5 when no historical counts are available", () => {
    expect(
      computeBaseRateOnlyProbability({
        referenceClass: "product_launch",
        calibrationSnapshot,
      }),
    ).toBe(0.5);
  });

  it("shrinks sparse reference classes toward global prior of 0.5", () => {
    const result = computeBaseRateOnlyProbability({
      referenceClass: "rare_class",
      calibrationSnapshot: {
        ...calibrationSnapshot,
        baseRateParams: {
          minimumSample: 20,
          historicalCounts: {
            rare_class: { successes: 2, total: 3 },
          },
        },
      },
    });
    const rawSmoothed = (2 + 1) / (3 + 2);
    expect(result).not.toBeCloseTo(rawSmoothed, 6);
    expect(result).toBeGreaterThan(0.5);
    expect(result).toBeLessThan(rawSmoothed);
  });

  describe("benchmark base rate", () => {
    const market = (id: string, theme: string, resolvedAt: string, resolvedValue: boolean) => ({
      id,
      theme,
      resolvedAt,
      resolvedValue,
    });
    const earlier = [
      ...Array.from({ length: 4 }, (_, index) => market(`yes-${index}`, "macro_economics", "2026-09-01T00:00:00Z", true)),
      ...Array.from({ length: 2 }, (_, index) => market(`no-${index}`, "macro_economics", "2026-09-02T00:00:00Z", false)),
    ];
    const target = market("target", "macro_economics", "2026-10-01T00:00:00Z", true);

    it("is the share of same-theme markets that had resolved Yes by the cutoff", () => {
      // 4 of 6 resolved Yes; with one pseudo-count each way that is 5 of 8.
      expect(
        computeBenchmarkBaseRate({ market: target, markets: [...earlier, target], cutoffAt: "2026-09-15T00:00:00Z" }),
      ).toBeCloseTo(5 / 8, 6);
    });

    it("does not use outcomes that were not known at the cutoff, including the market's own", () => {
      const later = market("later", "macro_economics", "2026-09-20T00:00:00Z", false);

      expect(
        computeBenchmarkBaseRate({ market: target, markets: [...earlier, later, target], cutoffAt: "2026-09-15T00:00:00Z" }),
      ).toBeCloseTo(5 / 8, 6);
    });

    it("pools every theme when its own theme has too few resolved markets", () => {
      const otherTheme = Array.from({ length: 6 }, (_, index) =>
        market(`other-${index}`, "politics_elections", "2026-09-01T00:00:00Z", false),
      );
      const lonely = market("lonely", "science_health", "2026-10-01T00:00:00Z", true);

      // No science markets had resolved: all 12 known outcomes are used, 4 Yes -> 5 of 14.
      expect(
        computeBenchmarkBaseRate({ market: lonely, markets: [...earlier, ...otherTheme, lonely], cutoffAt: "2026-09-15T00:00:00Z" }),
      ).toBeCloseTo(5 / 14, 6);
    });

    it("is 0.5 when nothing had resolved yet", () => {
      expect(computeBenchmarkBaseRate({ market: target, markets: [target], cutoffAt: "2026-09-15T00:00:00Z" })).toBe(0.5);
    });
  });
});
