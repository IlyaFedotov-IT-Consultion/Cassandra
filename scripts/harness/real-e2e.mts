#!/usr/bin/env tsx
/**
 * Cassandra real-world E2E harness.
 *
 * Drives the full API + judge pipeline against live third-party services
 * (OpenRouter, Perplexity sonar via OpenRouter). Seeds a small, deterministic
 * set of forecasting events, submits queued judgments, polls them to completion,
 * validates the verdict traces against the shared schema, and writes a
 * structured JSON artifact per run to scripts/harness/runs/<timestamp>/.
 *
 * Coverage map (keyed to solution-design sections):
 *   - §4.1 Explicit event workflow: event CRUD + judgment flow
 *   - §4.2 Watchlist workflow: watchlist CRUD + candidate listing
 *   - §4.3 Learning loop: outcome recording + calibration retraining
 *   - §8.3–8.5 Judging pipeline: verdict trace math invariants
 *   - §10.5 Evaluation: benchmark import + eval runs + predictions
 *   - §13.2 Caching: cache event trace entries
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
 *   - the API and worker share Redis because `POST /judgments` is queue-backed
 *
 * Exit code is 0 on success, 1 on any scenario failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  VerdictTraceSchema,
  EventRecordSchema,
  WatchlistRecordSchema,
  CalibrationSnapshotSchema,
  CalibrationSnapshotSummarySchema,
  BenchmarkSetSummarySchema,
  EvaluationRunSchema,
  type VerdictTrace,
  type EventRecord,
  type WatchlistRecord,
  type CalibrationSnapshot,
  type CalibrationSnapshotSummary,
} from "@cassandra/shared";
import {
  buildHarnessEnvironmentReport,
  validateEvaluationPipelineOutcome,
  validateTerminalJudgmentStatus,
  type HarnessEnvironmentReport,
  type HealthSnapshot,
} from "./real-e2e-support.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE ?? "http://localhost:3000";
const TIMEOUT_MS = Number.parseInt(process.env.HARNESS_TIMEOUT_MS ?? "420000", 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.HARNESS_POLL_MS ?? "2500", 10);
const ALLOW_INSUFFICIENT_EVIDENCE = process.env.HARNESS_ALLOW_INSUFFICIENT_EVIDENCE === "1";
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUNS_DIR = join(HERE, "runs", RUN_ID);

const EVIDENCE_STRENGTH_TO_LOG_BF: Record<string, number> = {
  strong_against: -3.0,
  moderate_against: -1.5,
  weak_against: -0.5,
  neutral: 0.0,
  weak_for: 0.5,
  moderate_for: 1.5,
  strong_for: 3.0,
};

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
  environment: HarnessEnvironmentReport;
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

/** Sends the API key when the API under test is configured with one. */
function apiHeaders(body: unknown): Record<string, string> {
  const apiKey = (process.env.CASSANDRA_API_KEY ?? "").trim();

  return {
    ...(body ? { "content-type": "application/json" } : {}),
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: apiHeaders(body),
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

async function apiRequestStatus(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, {
    method,
    headers: apiHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  };
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

// -- Shared state (populated by earlier scenarios, consumed by later ones) ----

const shared: {
  eventId?: string;
  judgmentId?: string;
  verdictTrace?: VerdictTrace;
  watchlistId?: string;
  benchmarkSetId?: string;
  calibrationSnapshotId?: string;
  approvedCalibrationSnapshotId?: string;
  latestUnapprovedCalibrationSnapshotId?: string;
  evaluationRunId?: string;
} = {};

interface JudgmentDetails {
  id: string;
  status: string;
  verdictTrace?: unknown;
  executionLog?: Array<{
    level: string;
    stage: string;
    message: string;
    details?: Record<string, unknown>;
  }>;
}

function parseSnapshotSummaries(list: unknown[], failures: string[]): CalibrationSnapshotSummary[] {
  const snapshots: CalibrationSnapshotSummary[] = [];

  for (const snapshot of list) {
    const parsed = CalibrationSnapshotSummarySchema.safeParse(snapshot);
    if (!parsed.success) {
      failures.push(`calibration snapshot list schema invalid: ${parsed.error.issues[0]?.message}`);
      break;
    }
    snapshots.push(parsed.data);
  }

  return snapshots;
}

function findCalibrationSnapshotLogId(judgment: JudgmentDetails): string | null {
  const calibrationEntry = judgment.executionLog?.find((entry) => entry.stage === "calibration");
  const snapshotId = calibrationEntry?.details?.calibrationSnapshotId;

  return typeof snapshotId === "string" && snapshotId.length > 0 ? snapshotId : null;
}

function findJudgmentFailureReason(judgment: JudgmentDetails): string | null {
  const runError = [...(judgment.executionLog ?? [])]
    .reverse()
    .find((entry) => entry.stage === "run" && entry.level === "error");
  const error = runError?.details?.error;

  return typeof error === "string" && error.length > 0 ? error : null;
}

async function enqueueAndPollJudgment(
  eventId: string,
  steps: StepRecord[],
  label?: string,
): Promise<JudgmentDetails> {
  const suffix = label ? ` (${label})` : "";
  const enqueued = await timed(
    `POST /judgments${suffix}`,
    () =>
      apiRequest<{ id: string; status: string }>("POST", "/judgments", {
        eventId,
      }),
    steps,
  );

  const deadline = Date.now() + TIMEOUT_MS;
  const terminal = await timed(
    `poll /judgments/:id until terminal${suffix}`,
    async () => {
      while (Date.now() < deadline) {
        const details = await apiRequest<JudgmentDetails>("GET", `/judgments/${enqueued.id}`);
        if (
          details.status === "completed"
          || details.status === "failed"
          || details.status === "insufficient_evidence"
        ) {
          return details;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error(`timed out after ${TIMEOUT_MS}ms waiting for judgment ${enqueued.id}`);
    },
    steps,
  );

  return terminal;
}

// -- Scenario runners ---------------------------------------------------------

async function scenarioEventCrud(): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const steps: StepRecord[] = [];
  const failures: string[] = [];

  try {
    const created = await timed(
      "POST /events",
      () =>
        apiRequest<EventRecord>("POST", "/events", {
          question: "Will the U.S. FDA approve any new GLP-1 receptor agonist drug by 2026-12-31?",
          resolutionCriteria:
            "Resolves YES if the FDA publishes an approval letter for any new molecular entity GLP-1 agonist between 2026-01-01 and 2026-12-31 inclusive.",
          deadline: "2026-12-31T23:59:59Z",
          entities: ["FDA", "GLP-1"],
          referenceClass: "regulatory_approval",
          marketSymbols: [],
        }),
      steps,
    );
    shared.eventId = created.id;

    const parsedCreate = EventRecordSchema.safeParse(created);
    if (!parsedCreate.success) {
      failures.push(`POST /events response schema invalid: ${parsedCreate.error.issues[0]?.message}`);
    }

    const fetched = await timed(
      "GET /events/:id",
      () => apiRequest<EventRecord>("GET", `/events/${created.id}`),
      steps,
    );

    const parsedGet = EventRecordSchema.safeParse(fetched);
    if (!parsedGet.success) {
      failures.push(`GET /events/:id response schema invalid: ${parsedGet.error.issues[0]?.message}`);
    }

    if (fetched.id !== created.id) {
      failures.push(`GET /events/:id returned wrong id: ${fetched.id} !== ${created.id}`);
    }
    if (fetched.question !== created.question) {
      failures.push("GET /events/:id returned wrong question");
    }

    const list = await timed(
      "GET /events",
      () => apiRequest<EventRecord[]>("GET", "/events"),
      steps,
    );

    if (!Array.isArray(list)) {
      failures.push("GET /events did not return an array");
    } else if (!list.some((e) => e.id === created.id)) {
      failures.push("GET /events does not include created event");
    }

    const notFound = await timed(
      "GET /events/:id (404)",
      () => apiRequestStatus("GET", "/events/00000000-0000-0000-0000-000000000000"),
      steps,
    );
    if (notFound.status !== 404) {
      failures.push(`GET /events/:id for missing event returned ${notFound.status}, expected 404`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return {
    scenario: "event-crud",
    ok: failures.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - start,
    steps,
    failures,
  };
}

async function scenarioJudgmentFlow(): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const steps: StepRecord[] = [];
  const failures: string[] = [];

  try {
    if (!shared.eventId) {
      throw new Error("scenarioJudgmentFlow requires shared.eventId from scenarioEventCrud");
    }

    const trace = await enqueueAndPollJudgment(shared.eventId, steps);
    shared.judgmentId = trace.id;

    if (trace.status === "failed") {
      const reason = findJudgmentFailureReason(trace);
      failures.push(
        reason
          ? `judgment reached terminal status 'failed': ${reason}`
          : "judgment reached terminal status 'failed'",
      );
      return finalize("judgment-flow", failures, steps, startedAt, start);
    }

    const terminalStatusFailure = validateTerminalJudgmentStatus(
      trace.status,
      ALLOW_INSUFFICIENT_EVIDENCE,
    );
    if (terminalStatusFailure) {
      failures.push(terminalStatusFailure);
    }

    if (!trace.verdictTrace) {
      failures.push("no verdictTrace on terminal judgment");
      return finalize("judgment-flow", failures, steps, startedAt, start);
    }

    const parsed = VerdictTraceSchema.safeParse(trace.verdictTrace);
    if (!parsed.success) {
      failures.push(`verdict schema invalid: ${parsed.error.issues[0]?.message}`);
      return finalize("judgment-flow", failures, steps, startedAt, start);
    }

    const vt = parsed.data;
    shared.verdictTrace = vt;
    if (shared.eventId && vt.eventId !== shared.eventId) {
      failures.push(`verdict eventId mismatch: ${vt.eventId} !== ${shared.eventId}`);
    }
    failures.push(...validateVerdictTraceInvariants(vt));

    const judgmentList = await timed(
      "GET /judgments?eventId=...",
      () =>
        apiRequest<Array<{ id: string; eventId: string }>>(
          "GET",
          `/judgments?eventId=${shared.eventId}`,
        ),
      steps,
    );

    if (!Array.isArray(judgmentList)) {
      failures.push("GET /judgments did not return an array");
    } else if (!judgmentList.some((j) => j.id === trace.id)) {
      failures.push("GET /judgments list does not include created judgment");
    }

    const notFound = await timed(
      "POST /judgments (404 for missing event)",
      () => apiRequestStatus("POST", "/judgments", { eventId: "00000000-0000-0000-0000-000000000000" }),
      steps,
    );
    if (notFound.status !== 404) {
      failures.push(`POST /judgments for missing event returned ${notFound.status}, expected 404`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return finalize("judgment-flow", failures, steps, startedAt, start);
}

async function scenarioWatchlistWorkflow(): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const steps: StepRecord[] = [];
  const failures: string[] = [];

  try {
    const created = await timed(
      "POST /watchlists",
      () =>
        apiRequest<WatchlistRecord>("POST", "/watchlists", {
          name: "EU AI regulation",
          keywords: ["EU AI Act", "Brussels AI enforcement", "foundation model fines"],
          jurisdictions: ["EU"],
          cadence: "6h",
          sourceToggles: {
            community: true,
            official: true,
            government: true,
            markets: true,
          },
        }),
      steps,
    );
    shared.watchlistId = created.id;

    const parsedCreate = WatchlistRecordSchema.safeParse(created);
    if (!parsedCreate.success) {
      failures.push(`POST /watchlists response schema invalid: ${parsedCreate.error.issues[0]?.message}`);
    }

    if (created.name !== "EU AI regulation") {
      failures.push(`watchlist name mismatch: ${created.name}`);
    }

    const fetched = await timed(
      "GET /watchlists/:id",
      () => apiRequest<WatchlistRecord>("GET", `/watchlists/${created.id}`),
      steps,
    );

    const parsedGet = WatchlistRecordSchema.safeParse(fetched);
    if (!parsedGet.success) {
      failures.push(`GET /watchlists/:id schema invalid: ${parsedGet.error.issues[0]?.message}`);
    }

    if (fetched.id !== created.id) {
      failures.push("GET /watchlists/:id returned wrong id");
    }

    const list = await timed(
      "GET /watchlists",
      () => apiRequest<WatchlistRecord[]>("GET", "/watchlists"),
      steps,
    );

    if (!Array.isArray(list)) {
      failures.push("GET /watchlists did not return an array");
    } else if (!list.some((w) => w.id === created.id)) {
      failures.push("GET /watchlists does not include created watchlist");
    }

    const candidates = await timed(
      "GET /watchlists/:id/candidates",
      () => apiRequest<unknown[]>("GET", `/watchlists/${created.id}/candidates`),
      steps,
    );

    if (!Array.isArray(candidates)) {
      failures.push("GET /watchlists/:id/candidates did not return an array");
    }

    const notFound = await timed(
      "GET /watchlists/:id (404)",
      () => apiRequestStatus("GET", "/watchlists/00000000-0000-0000-0000-000000000001"),
      steps,
    );
    if (notFound.status !== 404) {
      failures.push(`GET /watchlists/:id for missing watchlist returned ${notFound.status}, expected 404`);
    }

    const invalid = await timed(
      "POST /watchlists (400 for invalid input)",
      () => apiRequestStatus("POST", "/watchlists", { name: "" }),
      steps,
    );
    if (invalid.status !== 400) {
      failures.push(`POST /watchlists with invalid input returned ${invalid.status}, expected 400`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return finalize("watchlist-workflow", failures, steps, startedAt, start);
}

async function scenarioLearningLoop(): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const steps: StepRecord[] = [];
  const failures: string[] = [];

  try {
    if (!shared.eventId) {
      throw new Error("scenarioLearningLoop requires shared.eventId");
    }

    const outcome = await timed(
      "POST /outcomes",
      () =>
        apiRequest<{ id: string; eventId: string; resolvedValue: boolean }>(
          "POST",
          "/outcomes",
          {
            eventId: shared.eventId,
            resolvedValue: true,
            resolvedAt: "2026-04-10T12:00:00Z",
            resolutionSourceUrl: "https://example.gov/decision-123",
          },
        ),
      steps,
    );

    if (!outcome.id) {
      failures.push("POST /outcomes did not return an id");
    }
    if (outcome.eventId !== shared.eventId) {
      failures.push(`outcome eventId mismatch: ${outcome.eventId} !== ${shared.eventId}`);
    }

    const invalidOutcome = await timed(
      "POST /outcomes (400 for invalid input)",
      () =>
        apiRequestStatus("POST", "/outcomes", {
          eventId: shared.eventId,
          resolvedValue: "not-a-boolean",
        }),
      steps,
    );
    if (invalidOutcome.status !== 400) {
      failures.push(`POST /outcomes with invalid input returned ${invalidOutcome.status}, expected 400`);
    }

    const snapshot = await timed(
      "POST /backtests/retrain",
      () => apiRequest<CalibrationSnapshot>("POST", "/backtests/retrain"),
      steps,
    );

    const parsedSnapshot = CalibrationSnapshotSchema.safeParse(snapshot);
    if (!parsedSnapshot.success) {
      failures.push(`POST /backtests/retrain schema invalid: ${parsedSnapshot.error.issues[0]?.message}`);
    } else {
      shared.calibrationSnapshotId = parsedSnapshot.data.id;
      if (!parsedSnapshot.data.approved && parsedSnapshot.data.approved !== false) {
        failures.push("calibration snapshot missing approved field");
      }
      if (!["cold_start", "warming", "steady"].includes(parsedSnapshot.data.weightRegime)) {
        failures.push(`unexpected weightRegime: ${parsedSnapshot.data.weightRegime}`);
      }
    }

    const snapshotList = await timed(
      "GET /backtests/calibration-snapshots",
      () => apiRequest<unknown[]>("GET", "/backtests/calibration-snapshots"),
      steps,
    );

    if (!Array.isArray(snapshotList)) {
      failures.push("GET /backtests/calibration-snapshots did not return an array");
    } else {
      parseSnapshotSummaries(snapshotList, failures);
    }

    if (shared.calibrationSnapshotId) {
      const snapshotDetail = await timed(
        "GET /backtests/calibration-snapshots/:id",
        () =>
          apiRequest<CalibrationSnapshot>(
            "GET",
            `/backtests/calibration-snapshots/${shared.calibrationSnapshotId}`,
          ),
        steps,
      );

      const parsedDetail = CalibrationSnapshotSchema.safeParse(snapshotDetail);
      if (!parsedDetail.success) {
        failures.push(`GET calibration snapshot detail schema invalid: ${parsedDetail.error.issues[0]?.message}`);
      }
    }

    if (shared.calibrationSnapshotId) {
      const approvedSnapshot = await timed(
        "POST /backtests/calibration-snapshots/:id/approve",
        () =>
          // This scenario checks that an approved snapshot is the one judgments use, not whether the
          // snapshot deserves approval, so it overrides the held-out check.
          apiRequest<CalibrationSnapshot>(
            "POST",
            `/backtests/calibration-snapshots/${shared.calibrationSnapshotId}/approve`,
            { force: true },
          ),
        steps,
      );

      const parsedApproved = CalibrationSnapshotSchema.safeParse(approvedSnapshot);
      if (!parsedApproved.success) {
        failures.push(`POST calibration snapshot approve schema invalid: ${parsedApproved.error.issues[0]?.message}`);
      } else {
        shared.approvedCalibrationSnapshotId = parsedApproved.data.id;
        if (!parsedApproved.data.approved) {
          failures.push("approved snapshot response did not mark snapshot approved");
        }
      }
    }

    const listAfterApprove = await timed(
      "GET /backtests/calibration-snapshots (after approve)",
      () => apiRequest<unknown[]>("GET", "/backtests/calibration-snapshots"),
      steps,
    );

    if (!Array.isArray(listAfterApprove)) {
      failures.push("GET /backtests/calibration-snapshots after approve did not return an array");
    } else {
      const summaries = parseSnapshotSummaries(listAfterApprove, failures);
      if (shared.approvedCalibrationSnapshotId) {
        const approvedIndex = summaries.findIndex((snapshot) => snapshot.id === shared.approvedCalibrationSnapshotId);
        const firstUnapprovedIndex = summaries.findIndex((snapshot) => !snapshot.approved);
        if (approvedIndex === -1) {
          failures.push("approved snapshot missing from snapshot list after approve");
        } else if (firstUnapprovedIndex !== -1 && approvedIndex > firstUnapprovedIndex) {
          failures.push("approved snapshot was not ordered before unapproved snapshots");
        }
      }
    }

    const newerSnapshot = await timed(
      "POST /backtests/retrain (newer unapproved snapshot)",
      () => apiRequest<CalibrationSnapshot>("POST", "/backtests/retrain"),
      steps,
    );

    const parsedNewerSnapshot = CalibrationSnapshotSchema.safeParse(newerSnapshot);
    if (!parsedNewerSnapshot.success) {
      failures.push(`POST /backtests/retrain newer snapshot schema invalid: ${parsedNewerSnapshot.error.issues[0]?.message}`);
    } else {
      shared.latestUnapprovedCalibrationSnapshotId = parsedNewerSnapshot.data.id;
      if (parsedNewerSnapshot.data.approved) {
        failures.push("new retrained snapshot should start unapproved");
      }
    }

    const orderedSnapshotList = await timed(
      "GET /backtests/calibration-snapshots (ordering check)",
      () => apiRequest<unknown[]>("GET", "/backtests/calibration-snapshots"),
      steps,
    );

    if (!Array.isArray(orderedSnapshotList)) {
      failures.push("GET /backtests/calibration-snapshots ordering check did not return an array");
    } else {
      const summaries = parseSnapshotSummaries(orderedSnapshotList, failures);
      if (shared.approvedCalibrationSnapshotId && shared.latestUnapprovedCalibrationSnapshotId) {
        const approvedIndex = summaries.findIndex((snapshot) => snapshot.id === shared.approvedCalibrationSnapshotId);
        const newerIndex = summaries.findIndex((snapshot) => snapshot.id === shared.latestUnapprovedCalibrationSnapshotId);
        if (approvedIndex === -1 || newerIndex === -1) {
          failures.push("snapshot ordering check could not find approved and newer snapshot ids");
        } else if (approvedIndex > newerIndex) {
          failures.push("newer unapproved snapshot was ordered ahead of the approved snapshot");
        }
      }
    }

    if (shared.eventId && shared.approvedCalibrationSnapshotId) {
      const approvalSelectionJudgment = await enqueueAndPollJudgment(
        shared.eventId,
        steps,
        "approval-selection",
      );
      const approvalSelectionStatusFailure = validateTerminalJudgmentStatus(
        approvalSelectionJudgment.status,
        ALLOW_INSUFFICIENT_EVIDENCE,
      );
      if (approvalSelectionStatusFailure) {
        failures.push(`approval-selection ${approvalSelectionStatusFailure}`);
      }
      const selectedSnapshotId = findCalibrationSnapshotLogId(approvalSelectionJudgment);
      if (!selectedSnapshotId) {
        failures.push("approval-selection judgment did not log the loaded calibration snapshot id");
      } else if (selectedSnapshotId !== shared.approvedCalibrationSnapshotId) {
        failures.push(
          `approval-selection judgment loaded snapshot ${selectedSnapshotId} instead of approved snapshot ${shared.approvedCalibrationSnapshotId}`,
        );
      }
    }

    const notFound = await timed(
      "GET /backtests/calibration-snapshots/:id (404)",
      () => apiRequestStatus("GET", "/backtests/calibration-snapshots/00000000-0000-0000-0000-000000000002"),
      steps,
    );
    if (notFound.status !== 404) {
      failures.push(`GET calibration snapshot 404 returned ${notFound.status}, expected 404`);
    }

    const approveNotFound = await timed(
      "POST /backtests/calibration-snapshots/:id/approve (404)",
      () =>
        apiRequestStatus(
          "POST",
          "/backtests/calibration-snapshots/00000000-0000-0000-0000-000000000002/approve",
        ),
      steps,
    );
    if (approveNotFound.status !== 404) {
      failures.push(`POST calibration snapshot approve 404 returned ${approveNotFound.status}, expected 404`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return finalize("learning-loop", failures, steps, startedAt, start);
}

async function scenarioEvaluationPipeline(): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const steps: StepRecord[] = [];
  const failures: string[] = [];
  let benchmarkMarkets: unknown[] = [];
  let benchmarkSetCount = 0;
  let evaluationRunCreated = false;
  let importResult: { imported: unknown; markets: unknown } = {
    imported: undefined,
    markets: undefined,
  };

  try {
    importResult = await timed(
      "POST /evaluation/benchmarks/import/polymarket",
      () =>
        apiRequest<{ imported: number; markets: unknown[] }>(
          "POST",
          "/evaluation/benchmarks/import/polymarket",
          {},
        ),
      steps,
    );
    steps[steps.length - 1]!.detail = {
      imported: importResult.imported,
      marketCount: Array.isArray(importResult.markets) ? importResult.markets.length : null,
    };

    const benchmarkSets = await timed(
      "GET /evaluation/benchmark-sets",
      () => apiRequest<unknown[]>("GET", "/evaluation/benchmark-sets"),
      steps,
    );

    if (!Array.isArray(benchmarkSets)) {
      failures.push("GET /evaluation/benchmark-sets did not return an array");
    } else {
      benchmarkSetCount = benchmarkSets.length;
      for (const bs of benchmarkSets) {
        const p = BenchmarkSetSummarySchema.safeParse(bs);
        if (!p.success) {
          failures.push(`benchmark set summary schema invalid: ${p.error.issues[0]?.message}`);
          break;
        }
      }

      if (benchmarkSets.length > 0) {
        const firstSet = benchmarkSets[0] as { benchmarkSetId: string };
        shared.benchmarkSetId = firstSet.benchmarkSetId;

        benchmarkMarkets = await timed(
          "GET /evaluation/benchmark-sets/:id/markets",
          () =>
            apiRequest<unknown[]>(
              "GET",
              `/evaluation/benchmark-sets/${firstSet.benchmarkSetId}/markets`,
            ),
          steps,
        );

        if (!Array.isArray(benchmarkMarkets)) {
          failures.push("GET benchmark-sets/:id/markets did not return an array");
        }
      }
    }

    if (shared.benchmarkSetId) {
      const benchmarkMarketIds = Array.isArray(benchmarkMarkets)
        ? benchmarkMarkets
            .slice(0, 1)
            .map((market) =>
              typeof market === "object"
                && market !== null
                && "id" in market
                && typeof market.id === "string"
                ? market.id
                : null,
            )
            .filter((id): id is string => id !== null)
        : [];
      const runResponse = await timed(
        "POST /evaluation/runs",
        () =>
          apiRequestStatus("POST", "/evaluation/runs", {
            benchmarkSetId: shared.benchmarkSetId,
            benchmarkMarketIds: benchmarkMarketIds.length > 0 ? benchmarkMarketIds : undefined,
            baselines: ["base_rate_only", "polymarket_only"],
          }),
        steps,
      );

      if (runResponse.status === 201 || runResponse.status === 200) {
        const run = runResponse.body as { id: string };
        shared.evaluationRunId = run.id;
        evaluationRunCreated = true;

        if (!run.id) {
          failures.push("POST /evaluation/runs did not return an id");
        }

        const runDetail = await timed(
          "GET /evaluation/runs/:id",
          () => apiRequest<unknown>("GET", `/evaluation/runs/${run.id}`),
          steps,
        );

        const parsedRun = EvaluationRunSchema.safeParse(runDetail);
        if (!parsedRun.success) {
          failures.push(`evaluation run schema invalid: ${parsedRun.error.issues[0]?.message}`);
        } else {
          if (!parsedRun.data.baselines || parsedRun.data.baselines.length === 0) {
            failures.push("evaluation run has no baselines");
          }
          if (!parsedRun.data.cutoffs || parsedRun.data.cutoffs.length === 0) {
            failures.push("evaluation run has no cutoffs");
          }
        }

        const predictions = await timed(
          "GET /evaluation/runs/:id/predictions",
          () => apiRequest<unknown[]>("GET", `/evaluation/runs/${run.id}/predictions`),
          steps,
        );

        if (!Array.isArray(predictions)) {
          failures.push("GET /evaluation/runs/:id/predictions did not return an array");
        }
      } else if (runResponse.status === 500) {
        const body = runResponse.body as { message?: string } | undefined;
        const msg = body?.message ?? "";
        failures.push(`POST /evaluation/runs returned 500: ${msg.slice(0, 200)}`);
      } else {
        failures.push(`POST /evaluation/runs returned ${runResponse.status}`);
      }
    }

    const runsList = await timed(
      "GET /evaluation/runs",
      () => apiRequest<unknown[]>("GET", "/evaluation/runs"),
      steps,
    );

    if (!Array.isArray(runsList)) {
      failures.push("GET /evaluation/runs did not return an array");
    }

    const notFoundRun = await timed(
      "GET /evaluation/runs/:id (404)",
      () => apiRequestStatus("GET", "/evaluation/runs/00000000-0000-0000-0000-000000000003"),
      steps,
    );
    if (notFoundRun.status !== 404) {
      failures.push(`GET evaluation run 404 returned ${notFoundRun.status}, expected 404`);
    }

    const invalidRun = await timed(
      "POST /evaluation/runs (400 for missing benchmarkSetId)",
      () => apiRequestStatus("POST", "/evaluation/runs", {}),
      steps,
    );
    if (invalidRun.status !== 400) {
      failures.push(`POST /evaluation/runs with invalid input returned ${invalidRun.status}, expected 400`);
    }

    failures.push(
      ...validateEvaluationPipelineOutcome({
        importResult,
        benchmarkSetCount,
        benchmarkMarketCount: Array.isArray(benchmarkMarkets) ? benchmarkMarkets.length : 0,
        evaluationRunCreated,
      }),
    );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  return finalize("evaluation-pipeline", failures, steps, startedAt, start);
}

// -- Verdict trace design-doc invariant checks (§8.3–8.5) --------------------

function validateVerdictTraceInvariants(vt: VerdictTrace): string[] {
  const failures: string[] = [];

  if (vt.judgeOpinions.length < 3) {
    failures.push(`expected >= 3 judge opinions, got ${vt.judgeOpinions.length}`);
  }

  if (vt.citations.length < 1) {
    failures.push(`expected >= 1 citation, got ${vt.citations.length}`);
  }

  if (
    vt.status === "completed"
    && vt.citations.some((citation) => citation.url.includes("example.invalid"))
  ) {
    failures.push("verdict contains placeholder citations");
  }

  if (vt.finalProbability < 0 || vt.finalProbability > 1) {
    failures.push(`finalProbability out of [0,1]: ${vt.finalProbability}`);
  }

  if (vt.confidenceLow > vt.confidenceHigh) {
    failures.push(`confidence interval inverted: ${vt.confidenceLow} > ${vt.confidenceHigh}`);
  }

  const expectedJudgeNames = ["official_records", "community_signal", "open_web_research"];
  for (const name of expectedJudgeNames) {
    if (!vt.judgeOpinions.some((o) => o.judgeName === name)) {
      failures.push(`missing expected judge: ${name}`);
    }
  }

  // Ensemble judges report the median of their samples' log Bayes factors, which can fall
  // between two strength labels; single-sample judges map exactly to their label.
  const samplesByJudge = new Map<string, Array<{ evidenceStrength?: string }>>();
  for (const entry of vt.weightBreakdown) {
    const samples = (entry.details as { samples?: Array<{ evidenceStrength?: string; excluded?: string }> }).samples;
    // Samples excluded by the ensemble's consistency guard do not enter the median.
    const used = Array.isArray(samples) ? samples.filter((sample) => !sample.excluded) : [];
    if (used.length > 0) {
      samplesByJudge.set(entry.source, used);
    }
  }
  const medianOf = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : ((sorted[middle - 1]! + sorted[middle]!) / 2);
  };

  for (const opinion of vt.judgeOpinions) {
    if (opinion.probability < 0 || opinion.probability > 1) {
      failures.push(`${opinion.judgeName} probability out of [0,1]`);
    }
    if (!opinion.rationale || opinion.rationale.trim().length === 0) {
      failures.push(`${opinion.judgeName} rationale is empty`);
    }

    const samples = samplesByJudge.get(opinion.judgeName);
    const sampleBfs = (samples ?? [])
      .map((sample) => EVIDENCE_STRENGTH_TO_LOG_BF[sample.evidenceStrength ?? ""])
      .filter((value): value is number => typeof value === "number");
    const expectedBf =
      opinion.evidenceIds.length > 0 && sampleBfs.length > 0
        ? medianOf(sampleBfs)
        : EVIDENCE_STRENGTH_TO_LOG_BF[opinion.evidenceStrength];
    if (expectedBf !== undefined && Math.abs(opinion.logBayesFactor - expectedBf) > 1e-9) {
      failures.push(
        `${opinion.judgeName} logBayesFactor mismatch: expected ${expectedBf} (${samples ? "median of ensemble samples" : `evidenceStrength=${opinion.evidenceStrength}`}), got ${opinion.logBayesFactor}`,
      );
    }

    if (opinion.dependencyDiscount < 0 || opinion.dependencyDiscount > 1) {
      failures.push(`${opinion.judgeName} dependencyDiscount out of [0,1]: ${opinion.dependencyDiscount}`);
    }

    if (opinion.freshnessDecay < 0 || opinion.freshnessDecay > 1) {
      failures.push(`${opinion.judgeName} freshnessDecay out of [0,1]: ${opinion.freshnessDecay}`);
    }

    if (opinion.baseWeight < 0) {
      failures.push(`${opinion.judgeName} baseWeight is negative: ${opinion.baseWeight}`);
    }
  }

  if (vt.ensembleMethod !== "logarithmic_opinion_pool") {
    failures.push(`expected ensembleMethod 'logarithmic_opinion_pool', got '${vt.ensembleMethod}'`);
  }

  if (!["cold_start", "warming", "steady"].includes(vt.weightRegime)) {
    failures.push(`unexpected weightRegime: ${vt.weightRegime}`);
  }

  if (!["exact", "approximate"].includes(vt.replayFidelity)) {
    failures.push(`unexpected replayFidelity: ${vt.replayFidelity}`);
  }

  if (vt.disagreementShrinkage < 0 || vt.disagreementShrinkage >= 1) {
    failures.push(`disagreementShrinkage out of [0,1): ${vt.disagreementShrinkage}`);
  }

  if (!Array.isArray(vt.dependencyMatrix)) {
    failures.push("dependencyMatrix is not an array");
  } else {
    for (const entry of vt.dependencyMatrix) {
      if (entry.jaccard < 0 || entry.jaccard > 1) {
        failures.push(`dependencyMatrix jaccard out of [0,1]: ${entry.jaccard}`);
      }
    }
  }

  if (vt.weightBreakdown.length !== vt.judgeOpinions.length) {
    failures.push(
      `weightBreakdown length (${vt.weightBreakdown.length}) !== judgeOpinions length (${vt.judgeOpinions.length})`,
    );
  }

  for (const conflict of vt.conflicts) {
    if (!["low", "medium", "high"].includes(conflict.severity)) {
      failures.push(`conflict severity invalid: ${conflict.severity}`);
    }
    if (!conflict.reason || conflict.reason.trim().length === 0) {
      failures.push("conflict has empty reason");
    }
  }

  if (!Array.isArray(vt.cacheEvents)) {
    failures.push("cacheEvents is not an array");
  } else if (vt.status === "completed" && vt.cacheEvents.length === 0) {
    failures.push("cacheEvents is empty — expected at least one cache trace entry (§13.2)");
  }

  if (!vt.modelVersion || vt.modelVersion.trim().length === 0) {
    failures.push("modelVersion is empty");
  }
  if (!vt.weightVersion || vt.weightVersion.trim().length === 0) {
    failures.push("weightVersion is empty");
  }
  if (!vt.calibrationVersion || vt.calibrationVersion.trim().length === 0) {
    failures.push("calibrationVersion is empty");
  }

  return failures;
}

// -- Helpers ------------------------------------------------------------------

function finalize(
  name: string,
  failures: string[],
  steps: StepRecord[],
  startedAt: string,
  startMs: number,
): ScenarioResult {
  return {
    scenario: name,
    ok: failures.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - startMs,
    steps,
    failures,
  };
}

// -- Main ---------------------------------------------------------------------

async function assertApiReady(): Promise<HealthSnapshot> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await apiRequest<HealthSnapshot>("GET", "/health");
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
  const apiHealth = await assertApiReady();

  const scenarioRunners: Array<{ name: string; run: () => Promise<ScenarioResult> }> = [
    { name: "event-crud", run: scenarioEventCrud },
    { name: "judgment-flow", run: scenarioJudgmentFlow },
    { name: "watchlist-workflow", run: scenarioWatchlistWorkflow },
    { name: "learning-loop", run: scenarioLearningLoop },
    { name: "evaluation-pipeline", run: scenarioEvaluationPipeline },
  ];

  const scenarios: ScenarioResult[] = [];
  for (const { name, run } of scenarioRunners) {
    console.log(`[harness] running scenario: ${name}`);
    const result = await run();
    scenarios.push(result);
    writeFileSync(
      join(RUNS_DIR, `${name}.json`),
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
    environment: buildHarnessEnvironmentReport({
      env: process.env,
      apiHealth,
      allowInsufficientEvidence: ALLOW_INSUFFICIENT_EVIDENCE,
    }),
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
