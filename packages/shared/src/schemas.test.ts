import { describe, expect, it } from "vitest";

import {
  EventInputSchema,
  SourceFamilySchema,
  VerdictTraceSchema,
} from "./schemas.js";

describe("EventInputSchema", () => {
  it("parses a valid forecast event input", () => {
    const result = EventInputSchema.parse({
      question: "Will example corp launch product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if example corp announces general availability on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      marketSymbols: ["EXMPL"],
      polymarketMarketId: "market-123",
    });

    expect(result.question).toContain("product X");
    expect(result.entities).toEqual(["Example Corp", "Product X"]);
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
        priorProbability: 0.4,
        rawPosteriorProbability: 0.55,
        finalProbability: 0.57,
        confidenceLow: 0.49,
        confidenceHigh: 0.63,
        judgeOpinions: [],
        weightBreakdown: [],
        ensembleMethod: "logarithmic_opinion_pool",
        calibrationMethod: "isotonic",
        uncertaintyMethod: "bootstrap",
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
