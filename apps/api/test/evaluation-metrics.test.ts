import { describe, expect, it } from "vitest";

import {
  averageAbsoluteError,
  brierScore,
  calibrationBins,
  expectedCalibrationError,
  logLoss,
  sliceMetrics,
  winRateVsReference,
} from "../src/modules/evaluation/metrics.js";

describe("evaluation metrics", () => {
  const pairs = [
    {
      predicted: 0.8,
      outcome: 1,
      baseline: "model_with_polymarket" as const,
      theme: "tech",
      horizon: "30d",
      sourceConfiguration: "full",
      referencePredicted: 0.7,
    },
    {
      predicted: 0.6,
      outcome: 1,
      baseline: "model_with_polymarket" as const,
      theme: "tech",
      horizon: "30d",
      sourceConfiguration: "full",
      referencePredicted: 0.55,
    },
    {
      predicted: 0.3,
      outcome: 0,
      baseline: "model_without_polymarket" as const,
      theme: "policy",
      horizon: "7d",
      sourceConfiguration: "no_polymarket",
      referencePredicted: 0.4,
    },
    {
      predicted: 0.2,
      outcome: 0,
      baseline: "model_without_polymarket" as const,
      theme: "policy",
      horizon: "7d",
      sourceConfiguration: "no_polymarket",
      referencePredicted: 0.35,
    },
  ];

  it("computes deterministic scores", () => {
    expect(brierScore(pairs)).toBeCloseTo(0.0825, 6);
    expect(logLoss(pairs)).toBeCloseTo(0.328, 3);
    expect(averageAbsoluteError(pairs)).toBeCloseTo(0.275, 6);
    expect(winRateVsReference(pairs)).toBeCloseTo(1, 6);
  });

  it("computes calibration bins and expected calibration error", () => {
    const bins = calibrationBins(pairs, 2);

    expect(bins).toHaveLength(2);
    expect(expectedCalibrationError(pairs, 2)).toBeGreaterThanOrEqual(0);
    expect(bins[0]).toMatchObject({
      sampleSize: 2,
    });
  });

  it("builds slice metrics by theme, horizon, and source configuration", () => {
    const slices = sliceMetrics(pairs, {
      key: "theme",
      baseline: "model_with_polymarket",
    });
    const horizons = sliceMetrics(pairs, {
      key: "horizon",
      baseline: "model_without_polymarket",
    });
    const sourceConfigs = sliceMetrics(pairs, {
      key: "sourceConfiguration",
      baseline: "model_without_polymarket",
    });

    expect(slices).toEqual([
      expect.objectContaining({
        sliceKey: "tech",
        baseline: "model_with_polymarket",
        sampleSize: 2,
      }),
    ]);
    expect(horizons).toEqual([
      expect.objectContaining({
        sliceKey: "7d",
        baseline: "model_without_polymarket",
        sampleSize: 2,
      }),
    ]);
    expect(sourceConfigs).toEqual([
      expect.objectContaining({
        sliceKey: "no_polymarket",
        baseline: "model_without_polymarket",
        sampleSize: 2,
      }),
    ]);
  });

  it("handles empty pairs for all metrics", () => {
    expect(brierScore([])).toBe(0);
    expect(logLoss([])).toBe(0);
    expect(averageAbsoluteError([])).toBe(0);
    expect(winRateVsReference([])).toBe(0);
    expect(calibrationBins([])).toEqual([]);
    expect(expectedCalibrationError([])).toBe(0);
  });

  it("computes brier score of 0 for perfect predictions", () => {
    const perfect = [
      { predicted: 1, outcome: 1 },
      { predicted: 0, outcome: 0 },
    ];
    expect(brierScore(perfect)).toBe(0);
  });

  it("computes brier score of 1 for worst predictions", () => {
    const worst = [
      { predicted: 0, outcome: 1 },
      { predicted: 1, outcome: 0 },
    ];
    expect(brierScore(worst)).toBe(1);
  });

  it("computes log loss with boundary predictions clamped", () => {
    const boundary = [
      { predicted: 0, outcome: 1 },
      { predicted: 1, outcome: 0 },
    ];
    const loss = logLoss(boundary);
    expect(Number.isFinite(loss)).toBe(true);
    expect(loss).toBeGreaterThan(0);
  });

  it("computes win rate of 0 when model always loses", () => {
    const losing = [
      { predicted: 0.9, outcome: 0, referencePredicted: 0.1 },
      { predicted: 0.1, outcome: 1, referencePredicted: 0.9 },
    ];
    expect(winRateVsReference(losing)).toBe(0);
  });

  it("computes win rate of 0.5 on ties (conservative — ties are not wins)", () => {
    const tied = [
      { predicted: 0.5, outcome: 1, referencePredicted: 0.5 },
      { predicted: 0.8, outcome: 1, referencePredicted: 0.6 },
    ];
    expect(winRateVsReference(tied)).toBe(0.5);
  });

  it("handles calibration bins with single-bin edge case", () => {
    const bins = calibrationBins(pairs, 1);
    expect(bins).toHaveLength(1);
    expect(bins[0]?.sampleSize).toBe(4);
  });

  it("handles slice metrics with no matching baseline", () => {
    const slices = sliceMetrics(pairs, {
      key: "theme",
      baseline: "base_rate_only" as any,
    });
    expect(slices).toEqual([]);
  });

  it("handles averageAbsoluteError for all-correct predictions", () => {
    const correct = [
      { predicted: 1, outcome: 1 },
      { predicted: 0, outcome: 0 },
    ];
    expect(averageAbsoluteError(correct)).toBe(0);
  });
});
