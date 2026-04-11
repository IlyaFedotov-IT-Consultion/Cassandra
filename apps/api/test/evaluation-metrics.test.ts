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
});
