import {
  BenchmarkMarketSchema,
  BenchmarkSetSummarySchema,
  CalibrationSnapshotSchema,
  CalibrationSnapshotSummarySchema,
  CandidateEventRecordSchema,
  EvaluationPredictionSchema,
  EvaluationRunSchema,
  EvaluationRunSummarySchema,
  EventInputSchema,
  EventRecordSchema,
  JudgmentRecordDetailsSchema,
  JudgmentRecordSummarySchema,
  OutcomeInputSchema,
  OutcomeRecordSchema,
  RuntimeEventRecordSchema,
  WatchlistDiscoveryResultSchema,
  WatchlistInputSchema,
  WatchlistRecordSchema,
  type CalibrationSnapshot,
  type BenchmarkMarket,
  type CandidateEventRecord,
  type EvaluationPrediction,
  type EvaluationRun,
  type EvaluationRunSummary,
  type EventInput,
  type EventRecord,
  type JudgmentRecordDetails,
  type JudgmentRecordSummary,
  type OutcomeInput,
  type RuntimeEventRecord,
  type WatchlistInput,
  type WatchlistRecord,
} from "@cassandra/shared";

const eventListSchema = EventRecordSchema.array();
const watchlistListSchema = WatchlistRecordSchema.array();
const candidateListSchema = CandidateEventRecordSchema.array();
const judgmentListSchema = JudgmentRecordSummarySchema.array();
const runtimeEventListSchema = RuntimeEventRecordSchema.array();
const benchmarkSetListSchema = BenchmarkSetSummarySchema.array();
const benchmarkMarketListSchema = BenchmarkMarketSchema.array();
const evaluationRunSummaryListSchema = EvaluationRunSummarySchema.array();
const evaluationPredictionListSchema = EvaluationPredictionSchema.array();
const calibrationSnapshotListSchema = CalibrationSnapshotSummarySchema.array();
const outcomeListSchema = OutcomeRecordSchema.array();

interface BenchmarkImportResult {
  imported: number;
  markets: BenchmarkMarket[];
}

interface HealthResponse {
  status: string;
  adapterMode: string | null;
}

const defaultApiBaseUrl = String(import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000");

export function resolveApiBaseUrl(
  configuredBaseUrl: string,
  browserLocation: Pick<Location, "hostname" | "origin" | "protocol"> | undefined =
    typeof window === "undefined" ? undefined : window.location,
) {
  const normalizedConfiguredBaseUrl = configuredBaseUrl.replace(/\/$/, "");

  if (!browserLocation) {
    return normalizedConfiguredBaseUrl;
  }

  try {
    const resolvedUrl = new URL(normalizedConfiguredBaseUrl, browserLocation.origin);

    if (resolvedUrl.hostname === "api" || resolvedUrl.hostname === "host.docker.internal") {
      resolvedUrl.hostname = browserLocation.hostname;
      resolvedUrl.protocol = browserLocation.protocol;
    }

    return resolvedUrl.toString().replace(/\/$/, "");
  } catch {
    return normalizedConfiguredBaseUrl;
  }
}

export const apiBaseUrl = resolveApiBaseUrl(defaultApiBaseUrl);

export function extractApiErrorMessage(payload: unknown, status: number) {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload;
  }

  if (payload && typeof payload === "object") {
    if ("error" in payload && typeof payload.error === "string" && payload.error.trim().length > 0) {
      return payload.error;
    }

    if ("message" in payload && typeof payload.message === "string" && payload.message.trim().length > 0) {
      return payload.message;
    }

    if ("detail" in payload) {
      const { detail } = payload;

      if (typeof detail === "string" && detail.trim().length > 0) {
        return detail;
      }

      if (Array.isArray(detail) && detail.length > 0) {
        const [firstDetail] = detail;

        if (typeof firstDetail === "string" && firstDetail.trim().length > 0) {
          return firstDetail;
        }

        if (
          firstDetail &&
          typeof firstDetail === "object" &&
          "msg" in firstDetail &&
          typeof firstDetail.msg === "string" &&
          firstDetail.msg.trim().length > 0
        ) {
          return firstDetail.msg;
        }
      }
    }
  }

  return `Request failed with ${status}`;
}

async function requestJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);

  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers,
    ...init,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(extractApiErrorMessage(payload, response.status));
  }

  try {
    return schema.parse(payload);
  } catch (error) {
    throw new Error(describeValidationFailure(path, error));
  }
}

/** Turn a schema failure into one readable sentence instead of a dump of issues. */
function describeValidationFailure(path: string, error: unknown) {
  const issues =
    error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? (error.issues as Array<{ path?: Array<string | number>; message?: string }>)
      : [];
  const first = issues[0];
  const detail = first
    ? `${(first.path ?? []).join(".") || "response"}: ${first.message ?? "invalid value"}`
    : error instanceof Error
      ? error.message
      : "invalid response";
  return `The API returned an unexpected response from ${path.split("?")[0]} (${detail}).`;
}

export function splitCommaSeparated(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function toIsoStringFromLocalDateTime(value: string) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export async function fetchHealth() {
  return requestJson("/health", {
    parse(value: unknown) {
      if (!value || typeof value !== "object" || !("status" in value)) {
        throw new Error("Invalid health response");
      }

      return {
        status: String(value.status),
        adapterMode:
          "adapterMode" in value && typeof value.adapterMode === "string"
            ? value.adapterMode
            : null,
      } satisfies HealthResponse;
    },
  });
}

export async function fetchReady() {
  return requestJson("/ready", {
    parse(value: unknown) {
      if (!value || typeof value !== "object" || !("status" in value)) {
        throw new Error("Invalid readiness response");
      }

      return {
        status: String(value.status),
      };
    },
  });
}

export function listEvents() {
  return requestJson("/events", eventListSchema);
}

export function fetchEvent(eventId: string) {
  return requestJson(`/events/${encodeURIComponent(eventId)}`, EventRecordSchema);
}

export async function createEvent(input: EventInput) {
  return requestJson("/events", EventRecordSchema, {
    method: "POST",
    body: JSON.stringify(EventInputSchema.parse(input)),
  });
}

export async function recordOutcome(input: OutcomeInput) {
  return requestJson("/outcomes", OutcomeRecordSchema, {
    method: "POST",
    body: JSON.stringify(OutcomeInputSchema.parse(input)),
  });
}

/** Outcomes for one event, newest first; the first entry is the one in force. */
export function listOutcomes(eventId: string) {
  return requestJson(`/outcomes?eventId=${encodeURIComponent(eventId)}`, outcomeListSchema);
}

export function listWatchlists() {
  return requestJson("/watchlists", watchlistListSchema);
}

export function fetchWatchlist(watchlistId: string) {
  return requestJson(`/watchlists/${encodeURIComponent(watchlistId)}`, WatchlistRecordSchema);
}

export async function createWatchlist(input: WatchlistInput) {
  return requestJson("/watchlists", WatchlistRecordSchema, {
    method: "POST",
    body: JSON.stringify(WatchlistInputSchema.parse(input)),
  });
}

/** Collects and clusters fresh evidence for the watchlist now; providers that failed are reported, not fatal. */
export function runWatchlistDiscovery(watchlistId: string) {
  return requestJson(`/watchlists/${encodeURIComponent(watchlistId)}/discover`, WatchlistDiscoveryResultSchema, {
    method: "POST",
  });
}

export function listCandidates(watchlistId: string) {
  return requestJson(
    `/watchlists/${encodeURIComponent(watchlistId)}/candidates`,
    candidateListSchema,
  );
}

export function listJudgments(eventId?: string) {
  const suffix = eventId ? `?eventId=${encodeURIComponent(eventId)}` : "";
  return requestJson(`/judgments${suffix}`, judgmentListSchema);
}

export function fetchJudgment(judgmentId: string) {
  return requestJson(
    `/judgments/${encodeURIComponent(judgmentId)}`,
    JudgmentRecordDetailsSchema,
  );
}

export function listRuntimeEvents(filters?: {
  search?: string;
  judgmentStatus?: JudgmentRecordSummary["status"];
  stage?: RuntimeEventRecord["entry"]["stage"];
  level?: RuntimeEventRecord["entry"]["level"];
  limit?: number;
}) {
  const query = new URLSearchParams();

  if (filters?.search?.trim()) {
    query.set("search", filters.search.trim());
  }

  if (filters?.judgmentStatus) {
    query.set("judgmentStatus", filters.judgmentStatus);
  }

  if (filters?.stage) {
    query.set("stage", filters.stage);
  }

  if (filters?.level) {
    query.set("level", filters.level);
  }

  if (typeof filters?.limit === "number") {
    query.set("limit", String(filters.limit));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson(`/runtime${suffix}`, runtimeEventListSchema);
}

export async function runJudgment(eventId: string) {
  return requestJson("/judgments", JudgmentRecordDetailsSchema, {
    method: "POST",
    body: JSON.stringify({
      eventId,
    }),
  });
}

export function listBenchmarkSets() {
  return requestJson("/evaluation/benchmark-sets", benchmarkSetListSchema);
}

export function importPolymarketBenchmarks(benchmarkSetId?: string) {
  return requestJson<BenchmarkImportResult>(
    "/evaluation/benchmarks/import/polymarket",
    {
      parse(value: unknown) {
        if (!value || typeof value !== "object") {
          throw new Error("Invalid benchmark import response");
        }

        const imported =
          "imported" in value && typeof value.imported === "number" ? value.imported : null;
        const markets = "markets" in value ? benchmarkMarketListSchema.parse(value.markets) : null;

        if (imported === null || markets === null) {
          throw new Error("Invalid benchmark import response");
        }

        return {
          imported,
          markets,
        };
      },
    },
    {
      method: "POST",
      body: JSON.stringify(benchmarkSetId ? { benchmarkSetId } : {}),
    },
  );
}

export function listBenchmarkMarkets(benchmarkSetId: string) {
  return requestJson(
    `/evaluation/benchmark-sets/${encodeURIComponent(benchmarkSetId)}/markets`,
    benchmarkMarketListSchema,
  );
}

export function listEvaluationRuns() {
  return requestJson("/evaluation/runs", evaluationRunSummaryListSchema);
}

export function fetchEvaluationRun(runId: string) {
  return requestJson(`/evaluation/runs/${encodeURIComponent(runId)}`, EvaluationRunSchema);
}

export function listEvaluationPredictions(runId: string) {
  return requestJson(
    `/evaluation/runs/${encodeURIComponent(runId)}/predictions`,
    evaluationPredictionListSchema,
  );
}

export async function createEvaluationRun(args: {
  benchmarkSetId: string;
  baselines?: string[];
}) {
  return requestJson(`/evaluation/runs`, EvaluationRunSchema, {
    method: "POST",
    body: JSON.stringify({
      benchmarkSetId: args.benchmarkSetId,
      ...(args.baselines && args.baselines.length > 0 ? { baselines: args.baselines } : {}),
    }),
  });
}

export function listCalibrationSnapshots() {
  return requestJson("/backtests/calibration-snapshots", calibrationSnapshotListSchema);
}

export function fetchCalibrationSnapshot(snapshotId: string) {
  return requestJson(
    `/backtests/calibration-snapshots/${encodeURIComponent(snapshotId)}`,
    CalibrationSnapshotSchema,
  );
}

export async function retrainCalibrationSnapshot(): Promise<CalibrationSnapshot> {
  return requestJson("/backtests/retrain", CalibrationSnapshotSchema, {
    method: "POST",
  });
}

export async function approveCalibrationSnapshot(snapshotId: string): Promise<CalibrationSnapshot> {
  return requestJson(
    `/backtests/calibration-snapshots/${encodeURIComponent(snapshotId)}/approve`,
    CalibrationSnapshotSchema,
    {
      method: "POST",
    },
  );
}

export type {
  CalibrationSnapshot,
  CandidateEventRecord,
  EvaluationPrediction,
  EvaluationRun,
  EvaluationRunSummary,
  EventRecord,
  JudgmentRecordDetails,
  JudgmentRecordSummary,
  WatchlistRecord,
};
