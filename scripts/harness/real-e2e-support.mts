export interface HealthSnapshot {
  status?: string;
  adapterMode?: string;
}

export interface HarnessEnvironmentReport {
  process: {
    CASSANDRA_ADAPTER_MODE?: string;
    CASSANDRA_JUDGE_LLM?: string;
    OPENROUTER_JUDGE_MODEL?: string;
    OPENROUTER_SEARCH_MODEL?: string;
  };
  apiHealth: {
    status?: string;
    adapterMode?: string;
  };
  harness: {
    allowInsufficientEvidence: boolean;
  };
}

export interface EvaluationPipelineValidationInput {
  importResult: {
    imported: unknown;
    markets: unknown;
  };
  benchmarkSetCount: number;
  benchmarkMarketCount: number;
  evaluationRunCreated: boolean;
}

export function buildHarnessEnvironmentReport(args: {
  env: Record<string, string | undefined>;
  apiHealth?: HealthSnapshot;
  allowInsufficientEvidence: boolean;
}): HarnessEnvironmentReport {
  return {
    process: {
      CASSANDRA_ADAPTER_MODE: args.env.CASSANDRA_ADAPTER_MODE,
      CASSANDRA_JUDGE_LLM: args.env.CASSANDRA_JUDGE_LLM,
      OPENROUTER_JUDGE_MODEL: args.env.OPENROUTER_JUDGE_MODEL,
      OPENROUTER_SEARCH_MODEL: args.env.OPENROUTER_SEARCH_MODEL,
    },
    apiHealth: {
      status: args.apiHealth?.status,
      adapterMode: args.apiHealth?.adapterMode,
    },
    harness: {
      allowInsufficientEvidence: args.allowInsufficientEvidence,
    },
  };
}

export function validateTerminalJudgmentStatus(
  status: string,
  allowInsufficientEvidence: boolean,
): string | null {
  if (status === "completed") {
    return null;
  }

  if (status === "insufficient_evidence" && allowInsufficientEvidence) {
    return null;
  }

  return `expected status 'completed', got '${status}'`;
}

export function validateEvaluationPipelineOutcome(
  input: EvaluationPipelineValidationInput,
): string[] {
  const failures: string[] = [];

  if (typeof input.importResult.imported !== "number") {
    failures.push("benchmark import did not return imported count");
  }

  if (!Array.isArray(input.importResult.markets)) {
    failures.push("benchmark import did not return markets array");
  }

  if (
    typeof input.importResult.imported === "number"
    && input.importResult.imported <= 0
  ) {
    failures.push("benchmark import returned zero markets");
  }

  if (Array.isArray(input.importResult.markets) && input.importResult.markets.length === 0) {
    failures.push("benchmark import returned an empty markets array");
  }

  if (input.benchmarkSetCount === 0) {
    failures.push("GET /evaluation/benchmark-sets returned no benchmark sets after import");
  }

  if (input.benchmarkMarketCount === 0) {
    failures.push("GET /evaluation/benchmark-sets/:id/markets returned no benchmark markets");
  }

  if (!input.evaluationRunCreated) {
    failures.push("evaluation pipeline did not create a run");
  }

  return failures;
}
