#!/usr/bin/env tsx
/**
 * Cassandra real-world E2E harness.
 *
 * Drives the full API + judge pipeline against live third-party services
 * (OpenRouter, Perplexity sonar via OpenRouter). Seeds a small, deterministic
 * set of forecasting events, submits judgments, polls them to completion,
 * validates the verdict traces against the shared schema, and writes a
 * structured JSON artifact per run to scripts/harness/runs/<timestamp>/.
 *
 * Usage:
 *   pnpm harness:real             # uses defaults from .env
 *   API_BASE=http://localhost:3000 pnpm harness:real
 *   HARNESS_TIMEOUT_MS=600000 pnpm harness:real
 *
 * Preconditions:
 *   - docker compose --profile app up -d postgres redis api judge
 *   - .env contains a working OPENROUTER_API_KEY
 *   - CASSANDRA_JUDGE_LLM=openrouter and CASSANDRA_ADAPTER_MODE=live
 *     are exported to the judge / api containers (see docker-compose.yml)
 *
 * Exit code is 0 on success, 1 on any scenario failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VerdictTraceSchema, type VerdictTrace } from "@cassandra/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE ?? "http://localhost:3000";
const TIMEOUT_MS = Number.parseInt(process.env.HARNESS_TIMEOUT_MS ?? "420000", 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.HARNESS_POLL_MS ?? "2500", 10);
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUNS_DIR = join(HERE, "runs", RUN_ID);

interface Scenario {
  name: string;
  event: {
    question: string;
    resolutionCriteria: string;
    deadline: string;
    entities: string[];
    referenceClass: string | null;
    marketSymbols: string[];
  };
  // The harness does not assert a specific probability. Instead it asserts
  // that the trace satisfies the schema and the structural invariants below.
  expect: {
    minJudges: number;
    minCitations: number;
    mustCompleteStatus: "completed" | "insufficient_evidence";
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "fda-approval-2026",
    event: {
      question: "Will the U.S. FDA approve any new GLP-1 receptor agonist drug by 2026-12-31?",
      resolutionCriteria:
        "Resolves YES if the FDA publishes an approval letter for any new molecular entity GLP-1 agonist between 2026-01-01 and 2026-12-31 inclusive. Extensions of existing approvals do not count.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["FDA", "GLP-1"],
      referenceClass: "regulatory_approval",
      marketSymbols: [],
    },
    expect: { minJudges: 3, minCitations: 1, mustCompleteStatus: "completed" },
  },
  {
    name: "eu-ai-act-enforcement",
    event: {
      question:
        "Will the EU AI Act's general-purpose AI (GPAI) obligations become enforceable on or before 2027-06-30?",
      resolutionCriteria:
        "Resolves YES if by 2027-06-30 the European Commission publicly confirms that enforcement of the GPAI obligations under the EU AI Act is active. Delays in secondary legislation that push enforcement past 2027-06-30 resolve NO.",
      deadline: "2027-06-30T23:59:59Z",
      entities: ["European Commission", "EU AI Act", "GPAI"],
      referenceClass: "policy_decision",
      marketSymbols: [],
    },
    expect: { minJudges: 3, minCitations: 1, mustCompleteStatus: "completed" },
  },
];

interface StepRecord {
  step: string;
  ok: boolean;
  durationMs: number;
  detail?: unknown;
  error?: string;
}

interface ScenarioResult {
  scenario: string;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  steps: StepRecord[];
  eventId?: string;
  judgmentId?: string;
  verdictTrace?: VerdictTrace;
  failures: string[];
}

interface RunReport {
  runId: string;
  apiBase: string;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  ok: boolean;
  scenarios: ScenarioResult[];
  environment: Record<string, string | undefined>;
}

// -- HTTP helpers -------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`API ${status} on ${url}: ${body.slice(0, 500)}`);
    this.name = "ApiError";
  }
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, url, text);
  }
  if (text.length === 0) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

async function timed<T>(
  step: string,
  fn: () => Promise<T>,
  steps: StepRecord[],
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    steps.push({ step, ok: true, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({
      step,
      ok: false,
      durationMs: Date.now() - started,
      error: message,
    });
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- Validation ---------------------------------------------------------------

function validateVerdictTrace(
  trace: unknown,
  scenario: Scenario,
): { trace: VerdictTrace; failures: string[] } {
  const parsed = VerdictTraceSchema.safeParse(trace);
  if (!parsed.success) {
    return {
      trace: trace as VerdictTrace,
      failures: [`verdict schema invalid: ${parsed.error.issues[0]?.message}`],
    };
  }
  const failures: string[] = [];
  const value = parsed.data;

  if (value.status !== scenario.expect.mustCompleteStatus) {
    failures.push(
      `status is ${value.status}, expected ${scenario.expect.mustCompleteStatus}`,
    );
  }
  if (value.judgeOpinions.length < scenario.expect.minJudges) {
    failures.push(
      `only ${value.judgeOpinions.length} judge opinions, expected >= ${scenario.expect.minJudges}`,
    );
  }
  if (value.citations.length < scenario.expect.minCitations) {
    failures.push(
      `only ${value.citations.length} citations, expected >= ${scenario.expect.minCitations}`,
    );
  }
  if (value.finalProbability < 0 || value.finalProbability > 1) {
    failures.push(`finalProbability out of [0,1]: ${value.finalProbability}`);
  }
  if (value.confidenceLow > value.confidenceHigh) {
    failures.push(
      `confidence interval inverted: ${value.confidenceLow} > ${value.confidenceHigh}`,
    );
  }
  for (const opinion of value.judgeOpinions) {
    if (opinion.probability < 0 || opinion.probability > 1) {
      failures.push(`${opinion.judgeName} probability out of [0,1]`);
    }
    if (!opinion.rationale || opinion.rationale.trim().length === 0) {
      failures.push(`${opinion.judgeName} rationale is empty`);
    }
  }
  return { trace: value, failures };
}

// -- Per-scenario driver ------------------------------------------------------

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const scenarioStart = Date.now();
  const steps: StepRecord[] = [];
  const result: ScenarioResult = {
    scenario: scenario.name,
    ok: false,
    startedAt,
    finishedAt: startedAt,
    totalDurationMs: 0,
    steps,
    failures: [],
  };

  try {
    const created = await timed(
      "POST /events",
      () => apiRequest<{ id: string }>("POST", "/events", scenario.event),
      steps,
    );
    result.eventId = created.id;

    const enqueued = await timed(
      "POST /judgments",
      () =>
        apiRequest<{ id: string }>("POST", "/judgments", {
          eventId: created.id,
        }),
      steps,
    );
    result.judgmentId = enqueued.id;

    const deadline = Date.now() + TIMEOUT_MS;
    const trace = await timed(
      "poll /judgments/:id until terminal",
      async () => {
        while (Date.now() < deadline) {
          const details = await apiRequest<{
            status: string;
            verdictTrace?: unknown;
          }>("GET", `/judgments/${enqueued.id}`);
          const status = details.status;
          if (
            status === "completed" ||
            status === "failed" ||
            status === "insufficient_evidence"
          ) {
            return details;
          }
          await sleep(POLL_INTERVAL_MS);
        }
        throw new Error(
          `timed out after ${TIMEOUT_MS}ms waiting for judgment ${enqueued.id}`,
        );
      },
      steps,
    );

    if (trace.status === "failed") {
      result.failures.push("judgment reached terminal status 'failed'");
      result.ok = false;
      return finalize(result, scenarioStart);
    }

    if (!trace.verdictTrace) {
      result.failures.push("no verdictTrace on completed judgment");
      result.ok = false;
      return finalize(result, scenarioStart);
    }

    const validation = validateVerdictTrace(trace.verdictTrace, scenario);
    result.verdictTrace = validation.trace;
    result.failures.push(...validation.failures);
    result.ok = validation.failures.length === 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.failures.push(message);
    result.ok = false;
  }

  return finalize(result, scenarioStart);
}

function finalize(result: ScenarioResult, started: number): ScenarioResult {
  result.totalDurationMs = Date.now() - started;
  result.finishedAt = new Date().toISOString();
  return result;
}

// -- Main ---------------------------------------------------------------------

async function assertApiReady(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await apiRequest<{ status: string }>("GET", "/health");
      return;
    } catch (error) {
      if (attempt === 9) {
        throw new Error(
          `API at ${API_BASE} did not respond /health after 10 attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      await sleep(1500);
    }
  }
}

function printSummary(report: RunReport): void {
  const pass = report.scenarios.filter((s) => s.ok).length;
  const fail = report.scenarios.length - pass;
  console.log("\n===== Cassandra real E2E harness summary =====");
  console.log(`runId:        ${report.runId}`);
  console.log(`apiBase:      ${report.apiBase}`);
  console.log(`scenarios:    ${report.scenarios.length}`);
  console.log(`passing:      ${pass}`);
  console.log(`failing:      ${fail}`);
  console.log(`duration:     ${report.totalDurationMs} ms`);
  console.log(`artifact:     ${join(RUNS_DIR, "report.json")}`);
  console.log("");
  for (const scenario of report.scenarios) {
    const tag = scenario.ok ? "PASS" : "FAIL";
    console.log(
      `[${tag}] ${scenario.scenario} (${scenario.totalDurationMs} ms)`,
    );
    if (!scenario.ok) {
      for (const failure of scenario.failures) {
        console.log(`         - ${failure}`);
      }
    }
  }
  console.log("");
}

async function main(): Promise<number> {
  mkdirSync(RUNS_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  console.log(`[harness] runId=${RUN_ID} api=${API_BASE}`);
  console.log(`[harness] waiting for ${API_BASE}/health ...`);
  await assertApiReady();

  const scenarios: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    console.log(`[harness] running scenario: ${scenario.name}`);
    const result = await runScenario(scenario);
    scenarios.push(result);
    writeFileSync(
      join(RUNS_DIR, `${scenario.name}.json`),
      JSON.stringify(result, null, 2),
    );
  }

  const report: RunReport = {
    runId: RUN_ID,
    apiBase: API_BASE,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - startMs,
    ok: scenarios.every((s) => s.ok),
    scenarios,
    environment: {
      CASSANDRA_ADAPTER_MODE: process.env.CASSANDRA_ADAPTER_MODE,
      CASSANDRA_JUDGE_LLM: process.env.CASSANDRA_JUDGE_LLM,
      OPENROUTER_JUDGE_MODEL: process.env.OPENROUTER_JUDGE_MODEL,
      OPENROUTER_SEARCH_MODEL: process.env.OPENROUTER_SEARCH_MODEL,
    },
  };

  writeFileSync(
    join(RUNS_DIR, "report.json"),
    JSON.stringify(report, null, 2),
  );

  printSummary(report);
  return report.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error("[harness] fatal:", error);
    process.exit(1);
  });
