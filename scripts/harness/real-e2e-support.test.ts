import { describe, expect, it } from "vitest";

import {
  buildHarnessEnvironmentReport,
  isEvaluationRunFinished,
  planCalibrationCycle,
  summarizeCalibrationSnapshot,
  validateEvaluationPipelineOutcome,
  validateTerminalJudgmentStatus,
} from "./real-e2e-support.mjs";

describe("buildHarnessEnvironmentReport", () => {
  it("records API health adapter mode even when the local shell env is empty", () => {
    expect(
      buildHarnessEnvironmentReport({
        env: {},
        apiHealth: {
          status: "ok",
          adapterMode: "live",
        },
        allowInsufficientEvidence: false,
      }),
    ).toEqual({
      process: {
        CASSANDRA_ADAPTER_MODE: undefined,
        CASSANDRA_JUDGE_LLM: undefined,
        OPENROUTER_JUDGE_MODEL: undefined,
        OPENROUTER_SEARCH_MODEL: undefined,
      },
      apiHealth: {
        status: "ok",
        adapterMode: "live",
      },
      harness: {
        allowInsufficientEvidence: false,
      },
    });
  });
});

describe("validateTerminalJudgmentStatus", () => {
  it("treats insufficient evidence as a failure by default", () => {
    expect(validateTerminalJudgmentStatus("insufficient_evidence", false)).toBe(
      "expected status 'completed', got 'insufficient_evidence'",
    );
  });

  it("allows insufficient evidence when explicitly configured", () => {
    expect(validateTerminalJudgmentStatus("insufficient_evidence", true)).toBeNull();
  });
});

describe("validateEvaluationPipelineOutcome", () => {
  it("fails when the import is empty and no evaluation run is created", () => {
    expect(
      validateEvaluationPipelineOutcome({
        importResult: {
          imported: 0,
          markets: [],
        },
        benchmarkSetCount: 0,
        benchmarkMarketCount: 0,
        evaluationRunCreated: false,
      }),
    ).toEqual([
      "benchmark import returned zero markets",
      "benchmark import returned an empty markets array",
      "GET /evaluation/benchmark-sets returned no benchmark sets after import",
      "GET /evaluation/benchmark-sets/:id/markets returned no benchmark markets",
      "evaluation pipeline did not create a run",
    ]);
  });
});

describe("calibration cycle planning", () => {
  it("counts the paid model forecasts a cycle will make", () => {
    expect(
      planCalibrationCycle({
        markets: 30,
        baselines: ["base_rate_only", "polymarket_only", "model_without_polymarket", "model_with_polymarket"],
      }),
    ).toEqual({ markets: 30, horizons: 4, forecasts: 480, modelForecasts: 240 });
  });

  it("costs nothing in model calls when no model baseline is run", () => {
    expect(planCalibrationCycle({ markets: 30, baselines: ["polymarket_only"] }).modelForecasts).toBe(0);
  });
});

describe("calibration cycle report", () => {
  const snapshot = {
    id: "snapshot-1",
    weightRegime: "warming",
    resolvedOutcomeCount: 28,
    approved: false,
    judgeWeights: { official_records: 0.5, community_signal: 0.2, open_web_research: 0.3 },
    calibrationParams: { method: "logistic", slope: 0.8, intercept: 0.05 },
    marketPriorParams: { trustSlope: 0.9, trustIntercept: 0.01, fitted: true, sampleSize: 96 },
    metrics: {
      traceCount: 180,
      trainingSources: { judgments: 4, replayForecasts: 176, groups: 28 },
      heldOut: { folds: 5, sampleSize: 180, brierIdentity: 0.21, brierCalibrated: 0.19, improves: true },
    },
  };

  it("says a snapshot can be approved when its held-out check passed", () => {
    const report = summarizeCalibrationSnapshot(snapshot);

    expect(report.approvable).toBe(true);
    expect(report.lines).toContain("regime: warming (28 resolved markets and events, 180 forecasts)");
    expect(report.lines).toContain("trained on: 4 resolved judgments, 176 replayed forecasts");
    expect(report.lines).toContain("held-out Brier: 0.1900 calibrated vs 0.2100 uncalibrated (passed)");
    expect(report.lines).toContain("market trust: slope 0.900, intercept 0.010, fitted on 96 prices");
  });

  it("says why a snapshot should not be approved", () => {
    const failing = {
      ...snapshot,
      metrics: { ...snapshot.metrics, heldOut: { ...snapshot.metrics.heldOut, brierCalibrated: 0.24, improves: false } },
    };

    const report = summarizeCalibrationSnapshot(failing);

    expect(report.approvable).toBe(false);
    expect(report.reason).toMatch(/does not beat/);
  });

  it("says a cold-start snapshot changes nothing yet, and how many more markets it needs", () => {
    const report = summarizeCalibrationSnapshot({
      ...snapshot,
      weightRegime: "cold_start",
      resolvedOutcomeCount: 12,
      calibrationParams: { method: "identity" },
      metrics: { traceCount: 40, trainingSources: { judgments: 0, replayForecasts: 40, groups: 12 } },
    });

    expect(report.approvable).toBe(true);
    expect(report.lines).toContain("calibration map: none yet; 8 more resolved markets are needed before one is fitted");
  });
});

describe("evaluation run polling", () => {
  it("knows when a run has stopped", () => {
    expect(isEvaluationRunFinished({ status: "queued" })).toBe(false);
    expect(isEvaluationRunFinished({ status: "running" })).toBe(false);
    expect(isEvaluationRunFinished({ status: "completed" })).toBe(true);
    expect(isEvaluationRunFinished({ status: "failed" })).toBe(true);
    // A run stored before runs were queued has no status and is complete.
    expect(isEvaluationRunFinished({})).toBe(true);
  });
});
