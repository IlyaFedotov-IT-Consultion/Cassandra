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
  type WatchlistInput,
  type WatchlistRecord,
} from "@cassandra/shared";

const eventListSchema = EventRecordSchema.array();
const watchlistListSchema = WatchlistRecordSchema.array();
const candidateListSchema = CandidateEventRecordSchema.array();
const judgmentListSchema = JudgmentRecordSummarySchema.array();
const benchmarkSetListSchema = BenchmarkSetSummarySchema.array();
const benchmarkMarketListSchema = BenchmarkMarketSchema.array();
const evaluationRunSummaryListSchema = EvaluationRunSummarySchema.array();
const evaluationPredictionListSchema = EvaluationPredictionSchema.array();
const calibrationSnapshotListSchema = CalibrationSnapshotSummarySchema.array();

interface BenchmarkImportResult {
  imported: number;
  markets: BenchmarkMarket[];
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
    const errorMessage =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `Request failed with ${response.status}`;
    throw new Error(errorMessage);
  }

  return schema.parse(payload);
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
      };
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

export async function createEvaluationRun(benchmarkSetId: string) {
  return requestJson(`/evaluation/runs`, EvaluationRunSchema, {
    method: "POST",
    body: JSON.stringify({
      benchmarkSetId,
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
