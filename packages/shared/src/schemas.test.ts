import { describe, expect, it } from "vitest";

import {
  EvidenceStrengthSchema,
  EventInputSchema,
  SourceFamilySchema,
  VerdictTraceSchema,
  WeightRegimeSchema,
} from "./schemas.js";

describe("EventInputSchema", () => {
  it("parses a valid forecast event input with a known reference class", () => {
    const result = EventInputSchema.parse({
      question: "Will example corp launch product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if example corp announces general availability on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: ["EXMPL"],
      polymarketMarketId: "market-123",
    });

    expect(result.question).toContain("product X");
    expect(result.entities).toEqual(["Example Corp", "Product X"]);
    expect(result.referenceClass).toBe("product_launch");
  });

  it("accepts a null reference class fallback", () => {
    const result = EventInputSchema.parse({
      question: "Will the regulator approve therapy Y by 2026-12-31?",
      resolutionCriteria:
        "Counts only if the regulator posts a final approval decision on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Therapy Y", "The Regulator"],
      referenceClass: null,
    });

    expect(result.referenceClass).toBeNull();
  });
});

describe("SourceFamilySchema", () => {
  it("rejects an invalid source family", () => {
    expect(() => SourceFamilySchema.parse("newsletter")).toThrow();
  });
});

describe("VerdictTraceSchema", () => {
  it("requires judge opinions and citations", () => {
    expect(() =>
      VerdictTraceSchema.parse({
        id: "judgment-1",
        eventId: "event-1",
        evaluationTime: "2026-01-01T12:00:00Z",
        referenceClass: "product_launch",
        referenceClassFallback: null,
        priorProbability: 0.4,
        rawPosteriorProbability: 0.55,
        finalProbability: 0.57,
        confidenceLow: 0.49,
        confidenceHigh: 0.63,
        dependencyMatrix: [],
        disagreementShrinkage: 0.1,
        judgeOpinions: [],
        weightBreakdown: [],
        ensembleMethod: "logarithmic_opinion_pool",
        calibrationMethod: "isotonic",
        uncertaintyMethod: "bootstrap",
        weightRegime: "warming",
        replayFidelity: "approximate",
        conflicts: [],
        missingEvidence: [],
        citations: [],
        modelVersion: "judge-v1",
        weightVersion: "weights-v1",
        calibrationVersion: "cal-v1",
        status: "completed",
      }),
    ).toThrow();
  });
});

describe("EvidenceStrengthSchema", () => {
  it("accepts the full Likert range including moderate levels", () => {
    expect(EvidenceStrengthSchema.parse("moderate_against")).toBe("moderate_against");
    expect(EvidenceStrengthSchema.parse("moderate_for")).toBe("moderate_for");
  });

  it("rejects out-of-range strings", () => {
    expect(() => EvidenceStrengthSchema.parse("very_for")).toThrow();
  });
});

describe("WeightRegimeSchema", () => {
  it("only accepts the supported regimes", () => {
    expect(WeightRegimeSchema.parse("steady")).toBe("steady");
    expect(() => WeightRegimeSchema.parse("hot")).toThrow();
  });
});
