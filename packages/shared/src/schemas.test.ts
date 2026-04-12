import { describe, expect, it } from "vitest";

import {
  CalibrationSnapshotSchema,
  EvidenceStrengthSchema,
  EvaluationPredictionSchema,
  EvaluationRunSummarySchema,
  EventInputSchema,
  EventRecordSchema,
  JudgmentRecordDetailsSchema,
  JudgmentRecordSummarySchema,
  BenchmarkSetSummarySchema,
  SourceFamilySchema,
  VerdictTraceSchema,
  WatchlistRecordSchema,
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

  it("defaults an omitted nullable reference class to null", () => {
    const result = VerdictTraceSchema.parse({
      id: "trace-1",
      eventId: "event-1",
      evaluationTime: "2026-01-01T12:00:00Z",
      referenceClassFallback: "global_baseline",
      priorProbability: 0.4,
      rawPosteriorProbability: 0.55,
      finalProbability: 0.57,
      confidenceLow: 0.49,
      confidenceHigh: 0.63,
      dependencyMatrix: [],
      disagreementShrinkage: 0.1,
      judgeOpinions: [
        {
          judgeName: "official_records",
          probability: 0.57,
          confidence: 0.8,
          evidenceStrength: "moderate_for",
          rationale: "Official evidence supports the event.",
          evidenceIds: ["evidence-1"],
          warnings: [],
          logBayesFactor: 1.2,
          baseWeight: 0.4,
          dependencyDiscount: 1,
          freshnessDecay: 1,
          effectiveLogOddsContribution: 0.48,
          missingEvidence: [],
        },
      ],
      weightBreakdown: [{ source: "official_records", weight: 0.4, details: {} }],
      ensembleMethod: "logarithmic_opinion_pool",
      calibrationMethod: "identity",
      uncertaintyMethod: "bootstrap",
      weightRegime: "steady",
      replayFidelity: "exact",
      conflicts: [],
      missingEvidence: [],
      citations: [
        {
          title: "Example report",
          url: "https://example.com/report",
          sourceFamily: "official",
        },
      ],
      cacheEvents: [],
      modelVersion: "judge-v1",
      weightVersion: "weights-v1",
      calibrationVersion: "cal-v1",
      status: "completed",
    });

    expect(result.referenceClass).toBeNull();
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

describe("workspace response schemas", () => {
  it("parses event, watchlist, and judgment response records", () => {
    expect(
      EventRecordSchema.parse({
        id: "event-1",
        question: "Will Example Corp launch Product X by 2026-12-31?",
        resolutionCriteria: "Launch must be publicly announced.",
        deadline: "2026-12-31T23:59:59Z",
        status: "open",
        entities: ["Example Corp", "Product X"],
        referenceClass: "product_launch",
        marketSymbols: ["EXMPL"],
        polymarketMarketId: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ).toMatchObject({
      id: "event-1",
      referenceClass: "product_launch",
    });

    expect(
      WatchlistRecordSchema.parse({
        id: "watchlist-1",
        name: "Biotech approvals",
        keywords: ["FDA", "approval"],
        jurisdictions: ["US"],
        cadence: "daily",
        sourceToggles: {
          official: true,
        },
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ).toMatchObject({
      id: "watchlist-1",
      status: "active",
    });

    expect(
      JudgmentRecordSummarySchema.parse({
        id: "judgment-1",
        eventId: "event-1",
        status: "completed",
        verdictTrace: {
          id: "trace-1",
          eventId: "event-1",
          evaluationTime: "2026-01-01T12:00:00Z",
          referenceClass: "product_launch",
          referenceClassFallback: null,
          priorProbability: 0.4,
          rawPosteriorProbability: 0.5,
          finalProbability: 0.55,
          confidenceLow: 0.48,
          confidenceHigh: 0.61,
          dependencyMatrix: [],
          disagreementShrinkage: 0.1,
          judgeOpinions: [
            {
              judgeName: "official_records",
              probability: 0.6,
              confidence: 0.7,
              evidenceStrength: "weak_for",
              rationale: "Mildly supportive evidence.",
              evidenceIds: ["evidence-1"],
              warnings: [],
              logBayesFactor: 0.5,
              baseWeight: 0.33,
              dependencyDiscount: 1,
              freshnessDecay: 1,
              effectiveLogOddsContribution: 0.16,
              missingEvidence: [],
            },
          ],
          weightBreakdown: [{ source: "official_records", weight: 0.33, details: {} }],
          ensembleMethod: "logarithmic_opinion_pool",
          calibrationMethod: "identity",
          uncertaintyMethod: "bootstrap",
          weightRegime: "cold_start",
          replayFidelity: "exact",
          conflicts: [],
          missingEvidence: [],
          citations: [
            {
              title: "Example report",
              url: "https://example.com/report",
              sourceFamily: "web",
            },
          ],
          cacheEvents: [],
          modelVersion: "judge-v1",
          weightVersion: "weights-v1",
          calibrationVersion: "cal-v1",
          status: "completed",
        },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    ).toMatchObject({
      id: "judgment-1",
      verdictTrace: expect.objectContaining({
        finalProbability: 0.55,
      }),
    });
  });

  it("parses detailed judgment, evaluation, and calibration payloads", () => {
    expect(
      JudgmentRecordDetailsSchema.parse({
        id: "judgment-1",
        eventId: "event-1",
        status: "completed",
        verdictTrace: {
          id: "trace-1",
          eventId: "event-1",
          evaluationTime: "2026-01-01T12:00:00Z",
          referenceClass: "product_launch",
          referenceClassFallback: null,
          priorProbability: 0.4,
          rawPosteriorProbability: 0.5,
          finalProbability: 0.55,
          confidenceLow: 0.48,
          confidenceHigh: 0.61,
          dependencyMatrix: [],
          disagreementShrinkage: 0.1,
          judgeOpinions: [
            {
              judgeName: "official_records",
              probability: 0.6,
              confidence: 0.7,
              evidenceStrength: "weak_for",
              rationale: "Mildly supportive evidence.",
              evidenceIds: ["evidence-1"],
              warnings: [],
              logBayesFactor: 0.5,
              baseWeight: 0.33,
              dependencyDiscount: 1,
              freshnessDecay: 1,
              effectiveLogOddsContribution: 0.16,
              missingEvidence: [],
            },
          ],
          weightBreakdown: [{ source: "official_records", weight: 0.33, details: {} }],
          ensembleMethod: "logarithmic_opinion_pool",
          calibrationMethod: "identity",
          uncertaintyMethod: "bootstrap",
          weightRegime: "cold_start",
          replayFidelity: "exact",
          conflicts: [],
          missingEvidence: [],
          citations: [
            {
              title: "Example report",
              url: "https://example.com/report",
              sourceFamily: "web",
            },
          ],
          cacheEvents: [],
          modelVersion: "judge-v1",
          weightVersion: "weights-v1",
          calibrationVersion: "cal-v1",
          status: "completed",
        },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        judgeOpinions: [
          {
            id: "opinion-1",
            judgmentId: "judgment-1",
            judgeName: "official_records",
            probability: 0.6,
            confidence: 0.7,
            evidenceStrength: "weak_for",
            rationale: "Mildly supportive evidence.",
            evidenceIds: ["evidence-1"],
            warnings: [],
            logBayesFactor: 0.5,
            baseWeight: 0.33,
            dependencyDiscount: 1,
            freshnessDecay: 1,
            effectiveLogOddsContribution: 0.16,
            missingEvidence: [],
          },
        ],
      }),
    ).toMatchObject({
      judgeOpinions: expect.arrayContaining([
        expect.objectContaining({
          judgmentId: "judgment-1",
        }),
      ]),
    });

    expect(
      JudgmentRecordDetailsSchema.parse({
        id: "judgment-2",
        eventId: "event-1",
        status: "failed",
        verdictTrace: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        judgeOpinions: [],
      }).executionLog,
    ).toEqual([]);

    expect(
      BenchmarkSetSummarySchema.parse({
        benchmarkSetId: "polymarket_recent_resolved",
        marketCount: 42,
        earliestResolvedAt: "2026-01-01T00:00:00Z",
        latestResolvedAt: "2026-12-31T23:59:59Z",
        themes: ["technology"],
      }),
    ).toMatchObject({
      marketCount: 42,
    });

    expect(
      EvaluationRunSummarySchema.parse({
        id: "run-1",
        benchmarkSetId: "polymarket_recent_resolved",
        cutoffs: ["2026-01-01T00:00:00Z"],
        baselines: ["model_with_polymarket"],
        overallMetrics: {
          brierScore: 0.19,
        },
        replayFidelity: "exact",
        leakageWarnings: [],
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ).toMatchObject({
      id: "run-1",
      replayFidelity: "exact",
    });

    expect(
      EvaluationPredictionSchema.parse({
        id: "prediction-1",
        evaluationRunId: "run-1",
        benchmarkMarketId: "market-1",
        baseline: "model_with_polymarket",
        cutoffAt: "2026-01-01T00:00:00Z",
        predictedProbability: 0.62,
        outcome: true,
        theme: "technology",
        horizon: "30d",
        sourceConfiguration: "default",
        metadata: {},
        createdAt: "2026-01-02T00:00:00Z",
      }),
    ).toMatchObject({
      benchmarkMarketId: "market-1",
    });

    expect(
      CalibrationSnapshotSchema.parse({
        id: "snapshot-1",
        createdAt: "2026-01-02T00:00:00Z",
        trainingWindow: "all_time",
        judgeWeights: {},
        baseRateParams: {},
        marketPriorParams: {},
        calibrationParams: {},
        onlineLearningParams: {},
        metrics: {},
        weightRegime: "warming",
        resolvedOutcomeCount: 12,
        approved: false,
      }),
    ).toMatchObject({
      weightRegime: "warming",
    });
  });
});
