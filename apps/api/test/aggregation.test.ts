import { describe, expect, it } from "vitest";

import {
  probabilityToLogOdds,
  logOddsToProbability,
  clamp,
  average,
  variance,
  computeFreshnessDecay,
  computeJaccardOverlap,
  computeDependencyDiscount,
  computeDisagreementShrinkage,
  computePosteriorWithShrinkage,
} from "../src/modules/judgments/aggregation.js";

describe("log-odds transforms", () => {
  it("round-trips probability through log-odds", () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(logOddsToProbability(probabilityToLogOdds(p))).toBeCloseTo(p, 10);
    }
  });

  it("clamps probability near 0 for probabilityToLogOdds", () => {
    const result = probabilityToLogOdds(0);
    expect(result).toBeLessThan(-10);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("clamps probability near 1 for probabilityToLogOdds", () => {
    const result = probabilityToLogOdds(1);
    expect(result).toBeGreaterThan(10);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("handles very large positive log-odds", () => {
    expect(logOddsToProbability(100)).toBeCloseTo(1, 6);
  });

  it("handles very large negative log-odds", () => {
    expect(logOddsToProbability(-100)).toBeCloseTo(0, 6);
  });

  it("logOddsToProbability(0) returns 0.5", () => {
    expect(logOddsToProbability(0)).toBe(0.5);
  });
});

describe("computeFreshnessDecay", () => {
  it("returns 1.0 when publishedAt equals evaluationTime", () => {
    const t = "2026-04-12T12:00:00Z";
    expect(computeFreshnessDecay(t, t)).toBe(1);
  });

  it("returns clamped minimum 0.2 for very old evidence", () => {
    expect(
      computeFreshnessDecay("2020-01-01T00:00:00Z", "2026-04-12T12:00:00Z"),
    ).toBe(0.2);
  });

  it("returns 1.0 when publishedAt is in the future", () => {
    expect(
      computeFreshnessDecay("2026-04-13T00:00:00Z", "2026-04-12T00:00:00Z"),
    ).toBe(1);
  });

  it("decays by approximately exp(-1) at 168 hours", () => {
    const evalTime = "2026-04-19T12:00:00Z";
    const pubTime = "2026-04-12T12:00:00Z";
    const result = computeFreshnessDecay(pubTime, evalTime);
    expect(result).toBeCloseTo(Math.exp(-1), 4);
  });
});

describe("computeJaccardOverlap", () => {
  it("returns 0 for disjoint sets", () => {
    expect(computeJaccardOverlap(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(computeJaccardOverlap(["a", "b"], ["a", "b"])).toBe(1);
  });

  it("returns 0 for two empty sets", () => {
    expect(computeJaccardOverlap([], [])).toBe(0);
  });

  it("returns correct value for partial overlap", () => {
    expect(computeJaccardOverlap(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5, 10);
  });
});

describe("computeDependencyDiscount", () => {
  it("returns 1 when judge has no evidence", () => {
    const opinions = [
      { judgeName: "a", evidenceIds: [] },
      { judgeName: "b", evidenceIds: ["x"] },
    ];
    expect(computeDependencyDiscount("a", opinions)).toBe(1);
  });

  it("returns 1 when no overlap with other judges", () => {
    const opinions = [
      { judgeName: "a", evidenceIds: ["x"] },
      { judgeName: "b", evidenceIds: ["y"] },
    ];
    expect(computeDependencyDiscount("a", opinions)).toBe(1);
  });

  it("returns ~0.5 when two judges cite identical evidence", () => {
    const opinions = [
      { judgeName: "a", evidenceIds: ["x", "y"] },
      { judgeName: "b", evidenceIds: ["x", "y"] },
    ];
    expect(computeDependencyDiscount("a", opinions)).toBeCloseTo(0.5, 10);
  });

  it("discounts proportionally to overlap sum", () => {
    const opinions = [
      { judgeName: "a", evidenceIds: ["x", "y"] },
      { judgeName: "b", evidenceIds: ["x"] },
      { judgeName: "c", evidenceIds: ["y"] },
    ];
    const discount = computeDependencyDiscount("a", opinions);
    expect(discount).toBeGreaterThan(0);
    expect(discount).toBeLessThan(1);
  });
});

describe("computeDisagreementShrinkage", () => {
  it("returns 0 for identical log Bayes factors", () => {
    expect(computeDisagreementShrinkage([1.5, 1.5, 1.5])).toBe(0);
  });

  it("clamps at 0.6 for very high variance", () => {
    expect(computeDisagreementShrinkage([-3, 0, 3])).toBe(0.6);
  });

  it("returns 0 for empty array", () => {
    expect(computeDisagreementShrinkage([])).toBe(0);
  });
});

describe("computePosteriorWithShrinkage", () => {
  it("returns prior probability when shrinkage is 1", () => {
    const priorLogOdds = probabilityToLogOdds(0.3);
    const result = computePosteriorWithShrinkage({
      rawPosteriorLogOdds: probabilityToLogOdds(0.8),
      priorLogOdds,
      shrinkage: 1,
    });
    expect(result).toBeCloseTo(0.3, 6);
  });

  it("returns raw posterior when shrinkage is 0", () => {
    const result = computePosteriorWithShrinkage({
      rawPosteriorLogOdds: probabilityToLogOdds(0.8),
      priorLogOdds: probabilityToLogOdds(0.3),
      shrinkage: 0,
    });
    expect(result).toBeCloseTo(0.8, 6);
  });

  it("blends toward prior, not toward 0.5", () => {
    const prior = 0.7;
    const result = computePosteriorWithShrinkage({
      rawPosteriorLogOdds: probabilityToLogOdds(0.9),
      priorLogOdds: probabilityToLogOdds(prior),
      shrinkage: 0.5,
    });
    expect(result).toBeGreaterThan(prior);
    expect(result).toBeLessThan(0.9);
    expect(result).not.toBeCloseTo(0.5, 1);
  });
});
