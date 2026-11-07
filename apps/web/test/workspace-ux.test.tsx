import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { RouteErrorBoundary } from "../src/components/ui";

const QUESTION = "Will no Fed rate cuts happen in 2026?";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const event = {
  id: "event-fed",
  question: QUESTION,
  resolutionCriteria: "Resolves Yes if the FOMC makes no cut during 2026.",
  deadline: "2026-12-31T23:59:59Z",
  status: "active",
  entities: ["Federal Reserve", "FOMC"],
  referenceClass: "policy_decision",
  marketSymbols: [],
  polymarketMarketId: "0xabc",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
};

function trace(overrides: Record<string, unknown> = {}) {
  return {
    id: "trace-fed",
    eventId: "event-fed",
    evaluationTime: "2026-11-07T11:20:00Z",
    referenceClass: "policy_decision",
    referenceClassFallback: null,
    priorProbability: 0.979,
    rawPosteriorProbability: 0.994,
    preCalibrationProbability: 0.994,
    finalProbability: 0.994,
    confidenceLow: 0.944,
    confidenceHigh: 0.996,
    dependencyMatrix: [],
    disagreementShrinkage: 0,
    judgeOpinions: [
      {
        judgeName: "open_web_research",
        probability: 0.95,
        confidence: 0.85,
        evidenceStrength: "strong_for",
        rationale: "[openai/gpt-6.1-sol@high] The FOMC held in October after a September hike.",
        evidenceIds: ["ev-cnbc", "ev-fed"],
        warnings: ["deepseek/deepseek-v4.1-flash-1017@high excluded: moderate_against contradicts p=0.88"],
        logBayesFactor: 3,
        baseWeight: 1 / 3,
        dependencyDiscount: 1,
        freshnessDecay: 0.92,
        effectiveLogOddsContribution: 0.92,
        missingEvidence: [],
      },
    ],
    weightBreakdown: [
      {
        source: "open_web_research",
        weight: 1 / 3,
        details: {
          dependencyDiscount: 1,
          freshnessDecay: 0.92,
          effectiveLogOddsContribution: 0.92,
          samples: [
            { model: "openai/gpt-6.1-sol@high", probability: 0.96, evidenceStrength: "strong_for", rationale: "a" },
            { model: "anthropic/claude-opus-5.5@high", probability: 0.95, evidenceStrength: "strong_for", rationale: "b" },
            {
              model: "deepseek/deepseek-v4.1-flash-1017@high",
              probability: 0.88,
              evidenceStrength: "moderate_against",
              rationale: "c",
              excluded: "label contradicts probability",
            },
          ],
        },
      },
    ],
    ensembleMethod: "logarithmic_opinion_pool",
    calibrationMethod: "identity",
    uncertaintyMethod: "bootstrap",
    weightRegime: "cold_start",
    replayFidelity: "exact",
    conflicts: [],
    missingEvidence: [],
    citations: [
      {
        evidenceId: "ev-cnbc",
        title: "Fed holds rates steady",
        url: "https://www.cnbc.com/2026/10/28/fed-holds.html",
        sourceFamily: "web",
        publishedAt: "2026-10-28T00:00:00Z",
      },
      {
        evidenceId: "ev-fed",
        title: "Federal Reserve issues FOMC statement",
        url: "https://www.federalreserve.gov/press/monetary20261028a.htm",
        sourceFamily: "web",
        publishedAt: "2026-10-28T00:00:00Z",
      },
    ],
    cacheEvents: [{ layer: "judge_output", target: "panel", status: "miss" }],
    pipelineStages: [
      {
        stage: "query_planning",
        status: "completed",
        details: {
          model: "anthropic/claude-haiku-5.5@low",
          subQuestions: ["Has the FOMC cut at any 2026 meeting?"],
          queries: ["FOMC 2026 rate decisions December meeting"],
        },
      },
      {
        stage: "retrieval",
        status: "completed",
        details: {
          plannedQueries: 1,
          evidenceCount: 33,
          providers: [
            { name: "officialSearch", rawCount: 7, cacheStatus: "miss", error: null },
            { name: "polymarketClob", rawCount: 0, cacheStatus: "miss", error: "upstream timeout" },
          ],
        },
      },
      {
        stage: "relevance_rating",
        status: "completed",
        details: {
          model: "anthropic/claude-haiku-5.5@low",
          threshold: 4,
          rated: 14,
          kept: 5,
          unrated: 0,
          scores: { "ev-cnbc": 6, "ev-fed": 5, "ev-other": 2 },
          insufficientRelevantEvidence: false,
        },
      },
      {
        stage: "panel_reasoning",
        status: "completed",
        details: {
          models: "ensemble[openai/gpt-6.1-sol@high,anthropic/claude-opus-5.5@high,deepseek/deepseek-v4.1-flash-1017@high]",
          judges: { open_web_research: { evidenceCount: 2, samples: 3, excludedSamples: 1 } },
        },
      },
      { stage: "cross_examination", status: "skipped", details: { conflicts: 0 } },
      {
        stage: "aggregation",
        status: "completed",
        details: { priorProbability: 0.979, marketPriorUsed: true, rawPosteriorProbability: 0.994, disagreementShrinkage: 0 },
      },
      { stage: "calibration", status: "skipped", details: { method: "identity", snapshotId: "snapshot-1" } },
    ],
    modelVersion:
      "ensemble[openai/gpt-6.1-sol@high,anthropic/claude-opus-5.5@high,deepseek/deepseek-v4.1-flash-1017@high]",
    weightVersion: "snapshot-1",
    calibrationVersion: "snapshot-1",
    status: "completed",
    ...overrides,
  };
}

const executionLog = [
  {
    timestamp: "2026-11-07T11:18:00Z",
    level: "info",
    stage: "queue",
    message: "Judgment was queued for background processing.",
    details: { eventId: "event-fed" },
  },
  {
    timestamp: "2026-11-07T11:19:00Z",
    level: "info",
    stage: "evidence",
    message: "Evidence collection finished.",
    details: { evidenceCount: 33 },
  },
];

const judgments = [
  {
    id: "judgment-fed-2",
    eventId: "event-fed",
    status: "completed",
    verdictTrace: trace(),
    executionLog,
    createdAt: "2026-11-07T11:18:00Z",
    updatedAt: "2026-11-07T11:21:00Z",
  },
  {
    id: "judgment-fed-1",
    eventId: "event-fed",
    status: "completed",
    verdictTrace: trace({ id: "trace-fed-1", evaluationTime: "2026-11-05T09:00:00Z", finalProbability: 0.97, confidenceLow: 0.9, confidenceHigh: 0.99 }),
    executionLog,
    createdAt: "2026-11-05T09:00:00Z",
    updatedAt: "2026-11-05T09:03:00Z",
  },
];

const evaluationRun = {
  id: "run-paired",
  benchmarkSetId: "polymarket_recent_resolved",
  cutoffs: ["30d", "7d", "1d", "6h"],
  baselines: ["base_rate_only", "polymarket_only"],
  overallMetrics: {
    benchmarkCount: 3,
    predictionCount: 10,
    byBaseline: {
      base_rate_only: { brierScore: 0.25, logLoss: 0.69, averageAbsoluteError: 0.5, expectedCalibrationError: 0.5, winRateVsPolymarket: 0, sampleSize: 6 },
      polymarket_only: { brierScore: 0.18, logLoss: 0.53, averageAbsoluteError: 0.38, expectedCalibrationError: 0.22, winRateVsPolymarket: 0, sampleSize: 4 },
    },
    paired: {
      sampleSize: 4,
      byBaseline: {
        base_rate_only: { brierScore: 0.25, logLoss: 0.69, averageAbsoluteError: 0.5, expectedCalibrationError: 0.5, winRateVsPolymarket: 0.25, sampleSize: 4 },
        polymarket_only: { brierScore: 0.18, logLoss: 0.53, averageAbsoluteError: 0.38, expectedCalibrationError: 0.22, winRateVsPolymarket: 0, sampleSize: 4 },
      },
    },
  },
  sliceResults: [
    { sliceKey: "7d", baseline: "base_rate_only", brierScore: 0.25, logLoss: 0.69, averageAbsoluteError: 0.5, sampleSize: 2 },
    { sliceKey: "7d", baseline: "polymarket_only", brierScore: 0.12, logLoss: 0.4, averageAbsoluteError: 0.3, sampleSize: 2 },
    { sliceKey: "elections", baseline: "base_rate_only", brierScore: 0.25, logLoss: 0.69, averageAbsoluteError: 0.5, sampleSize: 2 },
    { sliceKey: "elections", baseline: "polymarket_only", brierScore: 0.2, logLoss: 0.6, averageAbsoluteError: 0.4, sampleSize: 2 },
    { sliceKey: "polymarket_only", baseline: "polymarket_only", brierScore: 0.18, logLoss: 0.53, averageAbsoluteError: 0.38, sampleSize: 4 },
  ],
  replayFidelity: "approximate",
  leakageWarnings: [
    "Skipped polymarket_only for m-1 at 2026-10-08T11:20:34.066Z: no benchmark Polymarket price snapshot available",
    "Skipped polymarket_only for m-2 at 2026-10-08T11:20:34.066Z: no benchmark Polymarket price snapshot available",
    "Skipped polymarket_only for m-3 at 2026-10-31T11:20:34.066Z: no benchmark Polymarket price snapshot available",
  ],
  createdAt: "2026-11-07T11:22:00Z",
};

const predictions = [0.2, 0.25, 0.7, 0.8].flatMap((probability, index) =>
  ["base_rate_only", "polymarket_only"].map((baseline) => ({
    id: `p-${baseline}-${index}`,
    evaluationRunId: "run-paired",
    benchmarkMarketId: `m-${index}`,
    baseline,
    cutoffAt: "2026-10-31T00:00:00Z",
    predictedProbability: baseline === "base_rate_only" ? 0.5 : probability,
    outcome: index >= 2,
    theme: "general",
    horizon: "7d",
    sourceConfiguration: baseline,
    metadata: {},
    createdAt: "2026-11-07T11:22:00Z",
  })),
);

const snapshots = [
  {
    id: "snapshot-new",
    createdAt: "2026-11-07T11:23:00Z",
    trainingWindow: "all_time",
    metrics: { brierScore: 0.21, logLoss: 0.61, expectedCalibrationError: 0.08, traceCount: 24 },
    weightRegime: "warming",
    resolvedOutcomeCount: 24,
    approved: false,
  },
  {
    id: "snapshot-approved",
    createdAt: "2026-11-01T08:00:00Z",
    trainingWindow: "all_time",
    metrics: { brierScore: 0.24, logLoss: 0.66, expectedCalibrationError: 0.12, traceCount: 20 },
    weightRegime: "warming",
    resolvedOutcomeCount: 20,
    approved: true,
  },
];

function snapshotDetail(summary: (typeof snapshots)[number]) {
  return {
    ...summary,
    judgeWeights: { official_records: 0.34, community_signal: 0.31, open_web_research: 0.35 },
    baseRateParams: {},
    marketPriorParams: {},
    calibrationParams: { method: "logistic", slope: 0.82, intercept: -0.05 },
    onlineLearningParams: { enabled: true, stepSizeScale: 0.5 },
  };
}

let requests: Array<{ method: string; path: string; body: unknown }> = [];
let recordedOutcomes: Array<Record<string, unknown>> = [];

beforeEach(() => {
  requests = [];
  recordedOutcomes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, body });

      if (url.pathname === "/health") return json({ status: "ok", adapterMode: "live" });
      if (url.pathname === "/ready") return json({ status: "ready" });
      if (method === "GET" && url.pathname === "/events") return json([event]);
      if (method === "GET" && url.pathname === "/events/event-fed") return json(event);
      if (method === "GET" && url.pathname === "/judgments") return json(judgments);
      if (method === "GET" && url.pathname === "/judgments/judgment-fed-2") return json({ ...judgments[0], judgeOpinions: trace().judgeOpinions });
      if (method === "GET" && url.pathname === "/judgments/judgment-new") {
        return json({ id: "judgment-new", eventId: "event-fed", status: "queued", verdictTrace: null, executionLog: [], judgeOpinions: [], createdAt: "2026-11-07T12:00:00Z", updatedAt: "2026-11-07T12:00:00Z" });
      }
      if (method === "POST" && url.pathname === "/judgments") {
        return json({ id: "judgment-new", eventId: "event-fed", status: "queued", verdictTrace: null, executionLog: [], judgeOpinions: [], createdAt: "2026-11-07T12:00:00Z", updatedAt: "2026-11-07T12:00:00Z" }, 202);
      }
      if (method === "POST" && url.pathname === "/outcomes") {
        const outcome = { id: `outcome-${recordedOutcomes.length + 1}`, createdAt: "2026-11-07T12:00:00Z", ...body };
        recordedOutcomes.unshift(outcome);
        return json(outcome, 201);
      }
      if (method === "GET" && url.pathname === "/outcomes") {
        return json(recordedOutcomes.filter((outcome) => outcome.eventId === url.searchParams.get("eventId")));
      }
      if (method === "GET" && url.pathname === "/evaluation/runs/run-paired") return json(evaluationRun);
      if (method === "GET" && url.pathname === "/evaluation/runs/run-paired/predictions") return json(predictions);
      if (method === "GET" && url.pathname.startsWith("/evaluation/benchmark-sets/")) return json([]);
      if (method === "GET" && url.pathname === "/backtests/calibration-snapshots") return json(snapshots);
      if (method === "GET" && url.pathname === "/backtests/calibration-snapshots/snapshot-new") return json(snapshotDetail(snapshots[0]!));
      if (method === "GET" && url.pathname === "/backtests/calibration-snapshots/snapshot-approved") return json(snapshotDetail(snapshots[1]!));
      if (method === "GET" && url.pathname === "/runtime") return json([]);
      return json({ error: `Unhandled ${method} ${url.pathname}` }, 404);
    }) as typeof fetch,
  );
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("judgment trace", () => {
  it("leads with the event question and the verdict", async () => {
    renderAt("/judgments/judgment-fed-2");

    expect(await screen.findByRole("heading", { level: 2, name: QUESTION })).toBeVisible();
    const verdict = screen.getByRole("region", { name: /verdict/i });
    expect(within(verdict).getByText("99.4%")).toBeVisible();
    expect(within(verdict).getByText(/prior 97\.9%/i)).toBeVisible();
    expect(within(verdict).getByText(/94\.4%.*99\.6%/)).toBeVisible();
  });

  it("lists the recorded pipeline stages in order with their key results", async () => {
    renderAt("/judgments/judgment-fed-2");

    const pipeline = await screen.findByRole("list", { name: /pipeline stages/i });
    const items = within(pipeline)
      .getAllByRole("listitem")
      .filter((item) => item.parentElement === pipeline);
    expect(items.map((item) => within(item).getByRole("heading").textContent)).toEqual([
      "Query planning",
      "Retrieval",
      "Relevance rating",
      "Panel reasoning",
      "Cross-examination",
      "Aggregation",
      "Calibration",
    ]);
    expect(within(pipeline).getByText("FOMC 2026 rate decisions December meeting")).toBeVisible();
    expect(within(pipeline).getByText(/33 items/)).toBeVisible();
    expect(within(pipeline).getByText(/polymarket clob failed: upstream timeout/i)).toBeVisible();
    expect(within(pipeline).getByText(/kept 5 of 14/i)).toBeVisible();
  });

  it("shows each model's sample and flags the ones the consistency guard excluded", async () => {
    renderAt("/judgments/judgment-fed-2");

    const samples = await screen.findByRole("table", { name: /open web research samples/i });
    const rows = within(samples).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("gpt-6.1-sol")).toBeVisible();
    expect(within(rows[0]!).getByText("96.0%")).toBeVisible();
    expect(within(rows[2]!).getByText(/excluded: label contradicts probability/i)).toBeVisible();
    expect(screen.queryByText(/\[openai\/gpt-6\.1-sol@high\]/)).not.toBeInTheDocument();
  });

  it("shows how relevant each cited source was rated", async () => {
    renderAt("/judgments/judgment-fed-2");

    const citation = await screen.findByRole("link", { name: /fed holds rates steady/i });
    expect(within(citation).getByText("Relevance 6/6")).toBeVisible();
  });

  it("keeps the execution log collapsed until it is opened", async () => {
    const user = userEvent.setup();
    renderAt("/judgments/judgment-fed-2");

    await screen.findByRole("heading", { level: 2, name: QUESTION });
    expect(screen.getByText("Evidence collection finished.")).not.toBeVisible();

    await user.click(screen.getByText(/execution log \(2 entries\)/i));

    expect(screen.getByText("Evidence collection finished.")).toBeVisible();
  });

  it("runs the judgment again for the same event", async () => {
    const user = userEvent.setup();
    renderAt("/judgments/judgment-fed-2");

    await user.click(await screen.findByRole("button", { name: /run again/i }));

    await waitFor(() => {
      expect(requests).toContainEqual({ method: "POST", path: "/judgments", body: { eventId: "event-fed" } });
    });
    expect(await screen.findByText(/judgment queued/i)).toBeVisible();
  });
});

describe("event detail", () => {
  it("charts the forecast across runs", async () => {
    renderAt("/events/event-fed");

    const chart = await screen.findByRole("img", { name: /forecast history/i });
    expect(within(chart).getAllByLabelText(/forecast \d+\.\d%/i)).toHaveLength(2);
  });

  it("records the resolved outcome for the event", async () => {
    const user = userEvent.setup();
    renderAt("/events/event-fed");

    await user.click(await screen.findByRole("button", { name: /record outcome/i }));
    const dialog = await screen.findByRole("dialog", { name: /record outcome/i });
    await user.click(within(dialog).getByLabelText(/^no$/i));
    await user.type(within(dialog).getByLabelText(/resolution source/i), "https://www.federalreserve.gov/decision");
    await user.click(within(dialog).getByRole("button", { name: /^record outcome$/i }));

    await waitFor(() => {
      const posted = requests.find((request) => request.method === "POST" && request.path === "/outcomes");
      expect(posted?.body).toMatchObject({
        eventId: "event-fed",
        resolvedValue: false,
        resolutionSourceUrl: "https://www.federalreserve.gov/decision",
      });
    });
    expect(await screen.findByText(/outcome recorded/i)).toBeVisible();
    expect(await screen.findByText(/^resolved no on /i)).toBeVisible();
    expect(screen.getByRole("button", { name: /update outcome/i })).toBeVisible();
  });

  it("shows the recorded resolution and links its source", async () => {
    recordedOutcomes = [
      {
        id: "outcome-0",
        eventId: "event-fed",
        resolvedValue: true,
        resolvedAt: "2026-12-31T23:59:59Z",
        resolutionSourceUrl: "https://www.federalreserve.gov/resolution",
        createdAt: "2026-11-07T11:00:00Z",
      },
    ];

    renderAt("/events/event-fed");

    expect(await screen.findByText(/^resolved yes on /i)).toBeVisible();
    expect(screen.getByRole("link", { name: /resolution source/i })).toHaveAttribute(
      "href",
      "https://www.federalreserve.gov/resolution",
    );
    expect(screen.getByRole("button", { name: /update outcome/i })).toBeVisible();
  });

  it("keeps the event usable when outcomes fail to load", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/outcomes") return json({ error: "database unavailable" }, 500);
      return base(input, init);
    });

    renderAt("/events/event-fed");

    expect(await screen.findByRole("img", { name: /forecast history/i })).toBeVisible();
    expect(await screen.findByText(/couldn't load the recorded outcome/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /record outcome/i })).toBeVisible();
  });
});

describe("event runs", () => {
  it("shows what a run that is still in progress is doing", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/judgments" && url.searchParams.get("eventId") === "event-fed") {
        const running = {
          id: "judgment-fed-3",
          eventId: "event-fed",
          status: "running",
          verdictTrace: null,
          executionLog: [
            ...executionLog,
            {
              timestamp: "2026-11-07T12:01:00Z",
              level: "info",
              stage: "judge",
              message: "Judge panel is reasoning over 12 sources.",
              details: {},
            },
          ],
          createdAt: "2026-11-07T12:00:00Z",
          updatedAt: "2026-11-07T12:01:00Z",
        };
        return json([running, ...judgments]);
      }
      return base(input, init);
    });

    renderAt("/events/event-fed");

    const runs = await screen.findByRole("list", { name: /runs/i });
    expect(within(runs).getByText(/judge panel is reasoning over 12 sources/i)).toBeVisible();
    expect(within(runs).queryByText(/evidence collection finished/i)).not.toBeInTheDocument();
  });
});

describe("watchlist discovery", () => {
  const watchlist = {
    id: "watchlist-fed",
    name: "Fed decisions",
    keywords: ["FOMC", "rate cut"],
    jurisdictions: ["US"],
    cadence: "daily",
    sourceToggles: {},
    status: "active",
    createdAt: "2026-11-01T09:00:00Z",
    updatedAt: "2026-11-01T09:00:00Z",
    lastDiscovery: { ranAt: "2026-11-07T09:00:00Z", trigger: "scheduled", candidateCount: 0, failedProviders: [] },
  };
  const candidate = {
    id: "candidate-1",
    watchlistId: "watchlist-fed",
    title: "Fed signals a December cut",
    description: "Several governors hinted at a cut in December.",
    supportingEvidenceIds: ["evidence-1", "evidence-2"],
    clusterKey: "fed-december-cut",
    promotionStatus: "pending",
    candidateSignature: null,
  };

  beforeEach(() => {
    let stored: unknown[] = [];
    let current: Record<string, unknown> = watchlist;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/watchlists") return json([current]);
      if (method === "POST" && url.pathname === "/watchlists") {
        const body = JSON.parse(String(init?.body));
        requests.push({ method, path: url.pathname, body });
        return json({ ...watchlist, ...body, id: "watchlist-new", lastDiscovery: null }, 201);
      }
      if (method === "GET" && url.pathname === "/watchlists/watchlist-fed") return json(current);
      if (method === "GET" && url.pathname === "/watchlists/watchlist-fed/candidates") return json(stored);
      if (method === "GET" && url.pathname === "/watchlists/watchlist-fed/schedule") {
        return json({ cadence: "daily", intervalMs: 86_400_000, nextRunAt: "2026-11-08T09:00:00.000Z" });
      }
      if (method === "POST" && url.pathname === "/watchlists/watchlist-fed/discover") {
        requests.push({ method, path: url.pathname, body: undefined });
        stored = [candidate];
        current = {
          ...watchlist,
          lastDiscovery: {
            ranAt: "2026-11-07T12:00:00Z",
            trigger: "manual",
            candidateCount: 1,
            failedProviders: [{ providerName: "polymarketGamma", error: "request timed out" }],
          },
        };
        return json({
          candidates: [candidate],
          failedProviders: [{ providerName: "polymarketGamma", error: "request timed out" }],
        });
      }
      return base(input, init);
    });
  });

  it("runs discovery from the watchlist and lists what it found", async () => {
    const user = userEvent.setup();
    renderAt("/watchlists/watchlist-fed");

    expect(await screen.findByRole("heading", { level: 2, name: "Fed decisions" })).toBeVisible();
    expect(screen.getByText(/no candidates yet/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /run discovery/i }));

    expect(await screen.findByText("Fed signals a December cut")).toBeVisible();
    expect(requests.filter((request) => request.path === "/watchlists/watchlist-fed/discover")).toHaveLength(1);
    expect(await screen.findByText(/discovery found 1 candidate\b/i)).toBeVisible();
    expect(screen.getByText(/polymarket gamma failed: request timed out/i)).toBeVisible();
    expect(await screen.findByText(/manual run, 1 candidate, 1 source failed/i)).toBeVisible();
  });

  it("shows when discovery runs next and how the last run went", async () => {
    renderAt("/watchlists/watchlist-fed");

    expect(await screen.findByText(/next run nov 8, 2026/i)).toBeVisible();
    expect(screen.getByText("Daily")).toBeVisible();
    expect(screen.getByText(/scheduled run, 0 candidates/i)).toBeVisible();
  });

  it("creates a watchlist on one of the supported cadences", async () => {
    const user = userEvent.setup();
    renderAt("/watchlists");

    await user.click(await screen.findByRole("button", { name: /create watchlist/i }));
    const dialog = await screen.findByRole("dialog", { name: /create watchlist/i });
    const cadence = within(dialog).getByRole("combobox", { name: /cadence/i });

    expect(within(cadence).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Manual",
      "Hourly",
      "Daily",
      "Weekly",
    ]);
    expect(cadence).toHaveValue("daily");

    await user.selectOptions(cadence, "weekly");
    await user.type(within(dialog).getByLabelText(/^name$/i), "ECB decisions");
    await user.type(within(dialog).getByLabelText(/keywords/i), "ECB, deposit rate");
    await user.click(within(dialog).getByRole("button", { name: /create watchlist/i }));

    await waitFor(() => {
      const posted = requests.find((request) => request.method === "POST" && request.path === "/watchlists");
      expect(posted?.body).toMatchObject({ name: "ECB decisions", cadence: "weekly", keywords: ["ECB", "deposit rate"] });
    });
  });
});

describe("evaluation run", () => {
  it("compares baselines on the paired sample and marks the best score", async () => {
    renderAt("/evaluation/runs/run-paired");

    const paired = await screen.findByRole("table", { name: /paired comparison/i });
    const polymarketRow = within(paired).getByRole("row", { name: /polymarket only/i });
    expect(within(polymarketRow).getByText("0.18")).toBeVisible();
    expect(within(polymarketRow).getAllByText(/best/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/4 market-cutoff pairs scored by every baseline/i)).toBeVisible();
  });

  it("groups repeated leakage warnings by reason", async () => {
    renderAt("/evaluation/runs/run-paired");

    expect(await screen.findByText(/no benchmark polymarket price snapshot available/i)).toBeVisible();
    expect(screen.getByText(/3 predictions/i)).toBeVisible();
    expect(screen.queryAllByText(/^Skipped polymarket_only for m-1/)).toHaveLength(0);
  });

  it("compares baselines within each horizon and theme slice", async () => {
    renderAt("/evaluation/runs/run-paired");

    const slices = await screen.findByRole("table", { name: /brier score by slice/i });
    const horizon = within(slices).getByRole("row", { name: /^7d/ });
    expect(within(horizon).getByText("0.12")).toBeVisible();
    expect(within(horizon).getByText(/best/i)).toBeVisible();
    expect(within(slices).getByRole("rowheader", { name: "Elections" })).toBeVisible();
    expect(within(slices).queryByRole("rowheader", { name: /polymarket only/i })).not.toBeInTheDocument();
  });

  it("plots how well each baseline's probabilities were calibrated", async () => {
    renderAt("/evaluation/runs/run-paired");

    const chart = await screen.findByRole("img", { name: /reliability/i });
    const legend = within(chart.closest("figure")!).getByRole("list", { name: /legend/i });
    expect(within(legend).getByText("Base rate only")).toBeVisible();
    expect(within(legend).getByText("Polymarket only")).toBeVisible();
  });
});

describe("calibration", () => {
  it("marks the snapshot judgments currently use and shows its scores", async () => {
    renderAt("/calibration");

    const history = await screen.findByRole("list", { name: /snapshot history/i });
    const approved = within(history).getAllByRole("listitem")[1]!;
    expect(within(approved).getByText(/in use/i)).toBeVisible();
    expect(within(within(history).getAllByRole("listitem")[0]!).queryByText(/in use/i)).not.toBeInTheDocument();

    expect(await screen.findByText("Brier score")).toBeVisible();
    expect(screen.getByText("0.21")).toBeVisible();
  });
});

describe("runtime activity", () => {
  it("names the event each entry belongs to instead of its raw id", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/runtime") {
        return json([
          {
            judgmentId: "judgment-fed-2",
            eventId: "event-fed",
            judgmentStatus: "completed",
            finalProbability: 0.994,
            entry: executionLog[0],
          },
        ]);
      }
      return base(input, init);
    });

    renderAt("/runtime");

    const row = await screen.findByRole("link", { name: new RegExp(QUESTION.replace(/[?]/g, "\\?"), "i") });
    expect(row).toHaveAttribute("href", "/judgments/judgment-fed-2");
    expect(within(row).queryByText(/^event event-fed$/i)).not.toBeInTheDocument();
  });
});

describe("workspace shell", () => {
  it("summarises service status in one compact line", async () => {
    renderAt("/events");

    const status = await screen.findByRole("status", { name: /service status/i });
    await waitFor(() => expect(within(status).getByText(/api ready/i)).toBeVisible());
    expect(within(status).getByText(/live mode/i)).toBeVisible();
  });

  it("closes dialogs with Escape and moves focus into them", async () => {
    const user = userEvent.setup();
    renderAt("/events");

    await user.click(await screen.findByRole("button", { name: /create event/i }));
    const dialog = await screen.findByRole("dialog", { name: /create event/i });
    expect(within(dialog).getByLabelText(/^question$/i)).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: /create event/i })).not.toBeInTheDocument();
  });

  it("keeps the shell usable when a page fails to render", () => {
    const Broken = () => {
      throw new Error("chart exploded");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <MemoryRouter>
        <RouteErrorBoundary>
          <Broken />
        </RouteErrorBoundary>
      </MemoryRouter>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/this page failed to render/i);
    expect(alert).toHaveTextContent(/chart exploded/i);
    consoleError.mockRestore();
  });

  it("lets the runtime console filter by the planning stage", async () => {
    renderAt("/runtime");

    const stage = await screen.findByLabelText(/runtime stage filter/i);
    expect(within(stage).getByRole("option", { name: "Planning" })).toBeInTheDocument();
  });
});
