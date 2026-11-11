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

const REPLAY_HORIZONS = 4;
const MODEL_BASELINES = new Set(["model_without_polymarket", "model_with_polymarket"]);
const WARMING_MARKETS = 20;

/** An evaluation run is finished once it has completed or failed. Runs without a status predate queueing. */
export function isEvaluationRunFinished(run: { status?: string }): boolean {
  return run.status === undefined || run.status === "completed" || run.status === "failed";
}

/**
 * What a calibration cycle will do before it is started. `modelForecasts` is the number of
 * judge requests: each one fans out to the whole judge ensemble, so it is what costs money.
 */
export function planCalibrationCycle(args: { markets: number; baselines: string[] }): {
  markets: number;
  horizons: number;
  forecasts: number;
  modelForecasts: number;
} {
  const modelBaselines = args.baselines.filter((baseline) => MODEL_BASELINES.has(baseline)).length;

  return {
    markets: args.markets,
    horizons: REPLAY_HORIZONS,
    forecasts: args.markets * REPLAY_HORIZONS * args.baselines.length,
    modelForecasts: args.markets * REPLAY_HORIZONS * modelBaselines,
  };
}

export interface CalibrationSnapshotLike {
  id: string;
  weightRegime: string;
  resolvedOutcomeCount: number;
  approved: boolean;
  judgeWeights: Record<string, unknown>;
  calibrationParams: Record<string, unknown>;
  marketPriorParams: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Turns a calibration snapshot into the lines a person needs to decide whether to approve
 * it: how much it was trained on, what it would change, and whether the change is shown to help.
 */
export function summarizeCalibrationSnapshot(snapshot: CalibrationSnapshotLike): {
  lines: string[];
  approvable: boolean;
  reason: string;
} {
  const metrics = snapshot.metrics;
  const sources = (metrics.trainingSources ?? {}) as Record<string, unknown>;
  const heldOut = metrics.heldOut as Record<string, unknown> | undefined;
  const method = String(snapshot.calibrationParams.method ?? "identity");
  const trust = snapshot.marketPriorParams;
  const lines = [
    `regime: ${snapshot.weightRegime} (${snapshot.resolvedOutcomeCount} resolved markets and events, ${numberOr(metrics.traceCount, 0)} forecasts)`,
    `trained on: ${numberOr(sources.judgments, 0)} resolved judgments, ${numberOr(sources.replayForecasts, 0)} replayed forecasts`,
  ];

  if (method === "identity") {
    const missing = Math.max(0, WARMING_MARKETS - snapshot.resolvedOutcomeCount);
    lines.push(
      missing > 0
        ? `calibration map: none yet; ${missing} more resolved markets are needed before one is fitted`
        : "calibration map: none",
    );
  } else {
    lines.push(
      method === "logistic"
        ? `calibration map: Platt scaling, slope ${numberOr(snapshot.calibrationParams.slope, 1).toFixed(3)}, intercept ${numberOr(snapshot.calibrationParams.intercept, 0).toFixed(3)}`
        : `calibration map: ${method}`,
    );
  }

  if (heldOut) {
    lines.push(
      `held-out Brier: ${numberOr(heldOut.brierCalibrated, 0).toFixed(4)} calibrated vs ${numberOr(heldOut.brierIdentity, 0).toFixed(4)} uncalibrated (${heldOut.improves === true ? "passed" : "failed"})`,
    );
  }

  lines.push(
    trust.fitted === true
      ? `market trust: slope ${numberOr(trust.trustSlope, 1).toFixed(3)}, intercept ${numberOr(trust.trustIntercept, 0).toFixed(3)}, fitted on ${numberOr(trust.sampleSize, 0)} prices`
      : `market trust: prices used as priced (${numberOr(trust.sampleSize, 0)} resolved prices are too few to fit)`,
  );
  lines.push(
    `judge weights: ${Object.entries(snapshot.judgeWeights)
      .map(([judge, weight]) => `${judge} ${numberOr(weight, 0).toFixed(2)}`)
      .join(", ")}`,
  );

  if (method === "identity") {
    return { lines, approvable: true, reason: "It applies no calibration map, so approving it only applies its weights and market trust." };
  }

  if (!heldOut) {
    return { lines, approvable: false, reason: "It changes forecasts but has no held-out score." };
  }

  return heldOut.improves === true
    ? { lines, approvable: true, reason: "Its calibration map beats uncalibrated forecasts on held-out data." }
    : { lines, approvable: false, reason: "Its calibration map does not beat uncalibrated forecasts on held-out data." };
}
