import { describe, expect, it } from "vitest";

import {
  buildHarnessEnvironmentReport,
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
