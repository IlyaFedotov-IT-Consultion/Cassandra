#!/usr/bin/env tsx
/**
 * Calibration cycle: produce enough resolved forecasts to fit a calibration snapshot.
 *
 * It imports a larger set of resolved Polymarket markets, replays them through the live
 * pipeline as one queued evaluation run, retrains calibration on the result, and reports
 * whether the new snapshot is worth approving. It never approves anything.
 *
 * THIS COSTS MONEY. Every model forecast is a judge request that fans out to the whole
 * judge ensemble, plus live search. Run it without CALIBRATION_CONFIRM to see the plan:
 *
 *   pnpm harness:calibration                        # prints the plan and exits
 *   CALIBRATION_CONFIRM=yes pnpm harness:calibration # runs it
 *
 * Needs the API in live mode (and the judge service with CASSANDRA_JUDGE_LLM=openrouter).
 *
 * Settings (environment variables):
 *   API_BASE                      default http://localhost:3000
 *   CASSANDRA_API_KEY             sent as x-api-key when set
 *   CALIBRATION_MARKETS           markets to import and replay, default 30
 *   CALIBRATION_WINDOW_DAYS       how far back a market may have resolved, default 120
 *   CALIBRATION_THEME_LIMIT       most markets from one theme, default 10
 *   CALIBRATION_PAGES             pages of 100 closed markets to scan, default 20
 *   CALIBRATION_BASELINES         comma-separated, default all four
 *   CALIBRATION_BENCHMARK_SET     benchmark set id, default calibration_cycle
 *   CALIBRATION_RUN_ID            resume a failed run or wait for an existing run; skips import
 *   CALIBRATION_SKIP_IMPORT=1     replay the stored benchmark set as it is
 *   CALIBRATION_TIMEOUT_MINUTES   how long to wait for the run, default 720
 *
 * A run that stops (or this script being interrupted) loses nothing: its finished markets
 * keep their forecasts, and the next retrain uses them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isEvaluationRunFinished,
  planCalibrationCycle,
  summarizeCalibrationSnapshot,
  type CalibrationSnapshotLike,
} from "./real-e2e-support.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.API_BASE ?? "http://localhost:3000";
const ALL_BASELINES = ["base_rate_only", "polymarket_only", "model_without_polymarket", "model_with_polymarket"];

function intSetting(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const settings = {
  markets: intSetting("CALIBRATION_MARKETS", 30),
  windowDays: intSetting("CALIBRATION_WINDOW_DAYS", 120),
  themeLimit: intSetting("CALIBRATION_THEME_LIMIT", 10),
  pages: intSetting("CALIBRATION_PAGES", 20),
  baselines: (process.env.CALIBRATION_BASELINES ?? ALL_BASELINES.join(","))
    .split(",")
    .map((baseline) => baseline.trim())
    .filter(Boolean),
  benchmarkSetId: process.env.CALIBRATION_BENCHMARK_SET ?? "calibration_cycle",
  skipImport: process.env.CALIBRATION_SKIP_IMPORT === "1",
  runId: process.env.CALIBRATION_RUN_ID?.trim(),
  timeoutMs: intSetting("CALIBRATION_TIMEOUT_MINUTES", 720) * 60_000,
  confirmed: (process.env.CALIBRATION_CONFIRM ?? "").toLowerCase() === "yes",
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const apiKey = (process.env.CASSANDRA_API_KEY ?? "").trim();
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }

  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const plan = planCalibrationCycle({ markets: settings.markets, baselines: settings.baselines });

  console.log("[calibration] plan");
  if (settings.runId) {
    console.log(`  existing run:    ${settings.runId}; resume if failed, otherwise wait; no import`);
    console.log("  paid forecasts:  only missing forecasts from the stored run; count available after confirmation");
  } else {
  console.log(`  benchmark set:   ${settings.benchmarkSetId}${settings.skipImport ? " (as stored, no import)" : ""}`);
  console.log(`  markets:         up to ${plan.markets}, resolved in the last ${settings.windowDays} days, at most ${settings.themeLimit} per theme`);
  console.log(`  baselines:       ${settings.baselines.join(", ")}`);
  console.log(`  forecasts:       up to ${plan.forecasts} (${plan.horizons} horizons per market)`);
  console.log(`  paid forecasts:  up to ${plan.modelForecasts} judge requests, each calling the whole judge ensemble, plus live search`);

  }

  if (!settings.confirmed) {
    console.log("\n[calibration] nothing was run. Set CALIBRATION_CONFIRM=yes to run this plan.");
    return 0;
  }

  const health = await api<{ adapterMode?: string }>("GET", "/health");

  if (health.adapterMode !== "live") {
    throw new Error(`the API is in ${health.adapterMode ?? "unknown"} mode; a calibration cycle needs CASSANDRA_ADAPTER_MODE=live`);
  }

  if (!settings.runId && !settings.skipImport) {
    const imported = await api<{ imported: number }>("POST", "/evaluation/benchmarks/import/polymarket", {
      benchmarkSetId: settings.benchmarkSetId,
      limit: settings.markets,
      windowDays: settings.windowDays,
      themeLimit: settings.themeLimit,
      pages: settings.pages,
    });
    console.log(`[calibration] imported ${imported.imported} resolved markets`);
  }

  type RunReference = { id: string; status?: string; progress?: { totalMarkets: number } | null };
  let queued: RunReference;
  if (settings.runId) {
    const path = `/evaluation/runs/${encodeURIComponent(settings.runId)}`;
    queued = await api<RunReference>("GET", path);
    if (queued.status === "failed") queued = await api<RunReference>("POST", `${path}/resume`);
  } else {
    queued = await api<RunReference>("POST", "/evaluation/runs", {
      benchmarkSetId: settings.benchmarkSetId,
      baselines: settings.baselines,
    });
  }
  console.log(`[calibration] evaluation run ${queued.id} queued for ${queued.progress?.totalMarkets ?? "?"} markets`);

  const deadline = Date.now() + settings.timeoutMs;
  let lastReported = -1;
  let run: {
    status?: string;
    error?: string | null;
    progress?: { completedMarkets: number; totalMarkets: number } | null;
    overallMetrics?: Record<string, unknown>;
    leakageWarnings?: string[];
  };

  for (;;) {
    run = await api("GET", `/evaluation/runs/${queued.id}`);
    const completed = run.progress?.completedMarkets ?? 0;

    if (completed !== lastReported) {
      console.log(`[calibration] ${completed} of ${run.progress?.totalMarkets ?? "?"} markets replayed`);
      lastReported = completed;
    }

    if (isEvaluationRunFinished(run)) {
      break;
    }

    if (Date.now() > deadline) {
      console.log(`[calibration] stopped waiting; run ${queued.id} keeps going on the server and keeps its forecasts`);
      return 1;
    }

    await sleep(15_000);
  }

  if (run.status === "failed") {
    console.log(`[calibration] the run failed: ${run.error ?? "no reason given"}. Its finished markets still count.`);
  }

  // Retrain on everything stored: resolved judgments, replayed forecasts and benchmark prices.
  const snapshot = await api<CalibrationSnapshotLike>("POST", "/backtests/retrain", {});
  const report = summarizeCalibrationSnapshot(snapshot);

  console.log(`\n[calibration] snapshot ${snapshot.id} (not approved)`);
  for (const line of report.lines) {
    console.log(`  ${line}`);
  }
  console.log(`  verdict: ${report.approvable ? "can be approved" : "should not be approved"}. ${report.reason}`);
  console.log("  Approve it from the Calibration page, or POST /backtests/calibration-snapshots/:id/approve.");

  const runDir = join(HERE, "runs", `calibration-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "report.json"),
    JSON.stringify({ settings: { ...settings, confirmed: undefined }, plan, evaluationRunId: queued.id, run, snapshot, report }, null, 2),
  );
  console.log(`[calibration] report written to ${join(runDir, "report.json")}`);

  return run.status === "failed" ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[calibration] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
