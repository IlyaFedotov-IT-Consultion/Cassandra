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
        stage: "prior",
        status: "completed",
        details: { source: "market", probability: 0.979, marketPrice: 0.979, marketLiquidity: 315000, relatedMarketsIgnored: 2 },
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
      if (method === "GET" && url.pathname === "/judgments/judgment-fed-1") return json({ ...judgments[1], judgeOpinions: trace().judgeOpinions });
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
      "Prior",
      "Panel reasoning",
      "Cross-examination",
      "Aggregation",
      "Calibration",
    ]);
    expect(within(pipeline).getByText("FOMC 2026 rate decisions December meeting")).toBeVisible();
    expect(within(pipeline).getByText(/33 items/)).toBeVisible();
    expect(within(pipeline).getByText(/polymarket clob failed: upstream timeout/i)).toBeVisible();
    expect(within(pipeline).getByText(/kept 5 of 14/i)).toBeVisible();
    expect(within(pipeline).getByText(/bound market's price, 97\.9%/i)).toBeVisible();
    expect(within(pipeline).getByText(/2 related markets found by search were not used/i)).toBeVisible();
  });

  function withJudgmentTrace(overrides: Record<string, unknown>) {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/judgments/judgment-fed-2") {
        const changed = trace(overrides);
        return json({ ...judgments[0], verdictTrace: changed, judgeOpinions: changed.judgeOpinions });
      }
      return base(input, init);
    });
  }

  it("says where the forecast range comes from", async () => {
    withJudgmentTrace({ uncertaintyMethod: "model_spread" });
    renderAt("/judgments/judgment-fed-2");
    expect(await screen.findByText("Range across the ensemble's models")).toBeVisible();
  });

  it("says when the range is a fixed band because no model spread was measured", async () => {
    withJudgmentTrace({ uncertaintyMethod: "none" });
    renderAt("/judgments/judgment-fed-2");
    expect(await screen.findByText("Fixed-width range: no spread between models was measured")).toBeVisible();
  });

  it("keeps the earlier label for traces whose range came from resampling judges", async () => {
    withJudgmentTrace({ uncertaintyMethod: "bootstrap" });
    renderAt("/judgments/judgment-fed-2");
    expect(await screen.findByText("Range from resampling judges")).toBeVisible();
  });

  it("warns when a judge failed and abstained", async () => {
    withJudgmentTrace({
      pipelineStages: trace().pipelineStages.map((stage: { stage: string; details: Record<string, unknown> }) =>
        stage.stage === "panel_reasoning"
          ? { ...stage, details: { ...stage.details, failedJudges: { official_records: "upstream returned garbage" } } }
          : stage,
      ),
    });
    renderAt("/judgments/judgment-fed-2");

    const pipeline = await screen.findByRole("list", { name: /pipeline stages/i });
    expect(
      within(pipeline).getByText("Official records failed and abstained: upstream returned garbage"),
    ).toBeVisible();
  });

  it("explains an estimated base rate when no market set the prior", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/judgments/judgment-fed-2") {
        const estimated = trace({
          pipelineStages: trace().pipelineStages.map((stage: { stage: string }) =>
            stage.stage === "prior"
              ? {
                  stage: "prior",
                  status: "completed",
                  details: {
                    source: "estimated_base_rate",
                    probability: 0.12,
                    referenceClass: "central bank surprise cuts",
                    rationale: "Unscheduled cuts are rare.",
                    relatedMarketsIgnored: 0,
                  },
                }
              : stage,
          ),
        });
        return json({ ...judgments[0], verdictTrace: estimated, judgeOpinions: estimated.judgeOpinions });
      }
      return base(input, init);
    });

    renderAt("/judgments/judgment-fed-2");

    const pipeline = await screen.findByRole("list", { name: /pipeline stages/i });
    expect(within(pipeline).getByText(/estimated base rate of 12\.0%/i)).toBeVisible();
    expect(within(pipeline).getByText(/unscheduled cuts are rare/i)).toBeVisible();
  });

  it("compares every model's samples across the judges and flags the excluded ones", async () => {
    const user = userEvent.setup();
    renderAt("/judgments/judgment-fed-2");

    const agreement = await screen.findByRole("region", { name: "Model agreement" });
    expect(within(agreement).getAllByRole("button", { name: / for open web research/i })).toHaveLength(3);

    await user.click(within(agreement).getByText("Show as table"));

    const rows = within(within(agreement).getByRole("table", { name: /model samples/i })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("gpt-6.1-sol")).toBeVisible();
    expect(within(rows[0]!).getByText("96.0%")).toBeVisible();
    expect(within(rows[2]!).getByText(/excluded: label contradicts probability/i)).toBeVisible();
    expect(screen.queryByText(/\[openai\/gpt-6\.1-sol@high\]/)).not.toBeInTheDocument();
  });

  it("charts how the forecast moved from the prior to the final number", async () => {
    renderAt("/judgments/judgment-fed-2");

    const path = await screen.findByRole("group", { name: /how the forecast moved/i });
    const steps = within(path).getAllByRole("listitem").map((item) => item.getAttribute("aria-label") ?? "");
    expect(steps[0]).toMatch(/^prior/i);
    expect(steps.some((step) => /^open web research/i.test(step))).toBe(true);
    expect(steps.at(-1)).toMatch(/^final.*99\.4%/i);
  });

  it("traces the kept evidence from each provider to the judges that read it", async () => {
    renderAt("/judgments/judgment-fed-2");

    const flow = await screen.findByRole("region", { name: "Evidence flow" });
    expect(within(flow).getByRole("button", { name: /^web: 2 kept/i })).toBeVisible();
    expect(within(flow).getByRole("button", { name: /^polymarket clob: 0 retrieved, 0 kept, failed/i })).toBeVisible();
    expect(within(flow).getByLabelText("2 items from Web read by Open web research")).toBeInTheDocument();
    expect(within(flow).getByText("Kept")).toBeVisible();
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

    const chart = await screen.findByRole("group", { name: /forecast history/i });
    expect(within(chart).getAllByLabelText(/forecast \d+\.\d%/i)).toHaveLength(2);
  });

  it("opens a run from its point on the forecast history", async () => {
    const user = userEvent.setup();
    renderAt("/events/event-fed");

    await user.click(await screen.findByRole("button", { name: /forecast 97\.0%/i }));

    expect(await screen.findByRole("button", { name: /run again/i })).toBeVisible();
    expect(within(screen.getByRole("region", { name: /verdict/i })).getByText("97.0%")).toBeVisible();
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
    expect(within(screen.getByRole("group", { name: /forecast history/i })).getByText("Resolved Yes")).toBeInTheDocument();
  });

  it("keeps the event usable when outcomes fail to load", async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/outcomes") return json({ error: "database unavailable" }, 500);
      return base(input, init);
    });

    renderAt("/events/event-fed");

    expect(await screen.findByRole("group", { name: /forecast history/i })).toBeVisible();
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
  function withEvaluationRun(overrides: Record<string, unknown>) {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/evaluation/runs/run-paired") return json({ ...evaluationRun, ...overrides });
      if (url.pathname === "/evaluation/runs") return json([{ ...evaluationRun, ...overrides, sliceResults: undefined }]);
      if (url.pathname === "/evaluation/benchmark-sets") return json([]);
      return base(input, init);
    });
  }

  it("shows how far a running run has got instead of scores", async () => {
    withEvaluationRun({
      status: "running",
      progress: { completedMarkets: 3, totalMarkets: 30 },
      overallMetrics: {},
      sliceResults: [],
    });

    renderAt("/evaluation/runs/run-paired");

    expect(await screen.findByText("Running: 3 of 30 markets replayed")).toBeVisible();
    expect(screen.getByText(/scores appear when the run finishes/i)).toBeVisible();
    expect(screen.queryByRole("table", { name: /paired comparison/i })).not.toBeInTheDocument();
  });

  it("says why a run failed and that its finished markets were kept", async () => {
    withEvaluationRun({
      status: "failed",
      error: "judge service is down",
      progress: { completedMarkets: 5, totalMarkets: 30 },
      overallMetrics: {},
      sliceResults: [],
    });

    renderAt("/evaluation/runs/run-paired");

    expect(await screen.findByText("Failed after 5 of 30 markets: judge service is down")).toBeVisible();
    expect(screen.getByText(/forecasts of the finished markets are kept/i)).toBeVisible();
  });

  it("resumes the failed run and shows its queued progress", async () => {
    withEvaluationRun({ status: "failed", error: "interrupted", progress: { completedMarkets: 5, totalMarkets: 30 }, overallMetrics: {}, sliceResults: [] });
    const base = vi.mocked(fetch).getMockImplementation()!;
    let resumed = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/evaluation/runs/run-paired/resume" && init?.method === "POST") {
        resumed = true;
        return json({ ...evaluationRun, status: "queued", progress: { completedMarkets: 5, totalMarkets: 30 } }, 202);
      }
      if (resumed && url.pathname === "/evaluation/runs/run-paired") return json({ ...evaluationRun, status: "queued", progress: { completedMarkets: 5, totalMarkets: 30 } });
      return base(input, init);
    });
    renderAt("/evaluation/runs/run-paired");
    await userEvent.click(await screen.findByRole("button", { name: "Resume run" }));
    expect(await screen.findByText("Queued: 30 markets to replay")).toBeVisible();
    expect(resumed).toBe(true);
  });

  it("compares each baseline with the market, with an interval over markets", async () => {
    withEvaluationRun({
      overallMetrics: {
        ...evaluationRun.overallMetrics,
        paired: {
          ...evaluationRun.overallMetrics.paired,
          vsPolymarket: {
            base_rate_only: { mean: 0.071, low: 0.02, high: 0.125, groups: 28 },
            model_with_polymarket: { mean: -0.004, low: -0.03, high: 0.021, groups: 28 },
            model_without_polymarket: null,
          },
        },
      },
    });

    renderAt("/evaluation/runs/run-paired");

    expect(
      await screen.findByText(
        "Base rate only: Brier 0.071 worse than Polymarket (95% interval 0.020 to 0.125 over 28 markets)",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Model with Polymarket: Brier 0.004 better than Polymarket (95% interval -0.030 to 0.021 over 28 markets); the interval includes no difference",
      ),
    ).toBeVisible();
  });

  it("marks an unfinished run in the run history", async () => {
    withEvaluationRun({ status: "running", progress: { completedMarkets: 3, totalMarkets: 30 }, overallMetrics: {} });

    renderAt("/evaluation");

    expect(await screen.findByText("Running, 3 of 30 markets")).toBeVisible();
  });

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

    const chart = await screen.findByRole("group", { name: /reliability/i });
    const legend = within(chart.closest("figure")!).getByRole("list", { name: /legend/i });
    expect(within(legend).getByRole("button", { name: "Base rate only" })).toHaveAttribute("aria-pressed", "true");
    expect(within(legend).getByRole("button", { name: "Polymarket only" })).toHaveAttribute("aria-pressed", "true");
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

  function withCalibrationSnapshots(list: unknown[], detail: Record<string, unknown>) {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/backtests/calibration-snapshots") return json(list);
      if (method === "GET" && url.pathname === "/backtests/calibration-snapshots/snapshot-new") return json(detail);
      if (method === "POST" && url.pathname === "/backtests/calibration-snapshots/snapshot-new/approve") {
        await base(input, init);
        return json({ ...detail, approved: true });
      }
      return base(input, init);
    });
  }

  it("says judgments run uncalibrated while no snapshot is approved", async () => {
    withCalibrationSnapshots([snapshots[0]], snapshotDetail(snapshots[0]!));

    renderAt("/calibration");

    const history = await screen.findByRole("list", { name: /snapshot history/i });
    expect(within(history).queryByText(/in use/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no snapshot is approved/i)).toBeVisible();
  });

  it("shows a failed held-out check and only approves the snapshot when asked to override it", async () => {
    const user = userEvent.setup();
    const failing = {
      ...snapshots[0]!,
      metrics: {
        ...snapshots[0]!.metrics,
        heldOut: { folds: 5, sampleSize: 24, brierIdentity: 0.212, brierCalibrated: 0.248, improves: false },
      },
    };
    withCalibrationSnapshots([failing], snapshotDetail(failing));

    renderAt("/calibration");

    expect(await screen.findByText(/held-out check failed/i)).toBeVisible();
    expect(screen.getByText(/0\.248 calibrated against 0\.212 uncalibrated/i)).toBeVisible();
    const override = await screen.findByRole("button", { name: /approve anyway/i });
    expect(screen.queryByRole("button", { name: /^approve snapshot$/i })).not.toBeInTheDocument();

    await user.click(override);

    await waitFor(() => {
      expect(requests.find((request) => request.path.endsWith("/snapshot-new/approve"))?.body).toEqual({ force: true });
    });
  });

  it("approves a snapshot that passed its held-out check without overriding anything", async () => {
    const user = userEvent.setup();
    const passing = {
      ...snapshots[0]!,
      metrics: {
        ...snapshots[0]!.metrics,
        heldOut: { folds: 5, sampleSize: 24, brierIdentity: 0.262, brierCalibrated: 0.214, improves: true },
      },
    };
    withCalibrationSnapshots([passing], snapshotDetail(passing));

    renderAt("/calibration");

    expect(await screen.findByText(/held-out check passed/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^approve snapshot$/i }));

    await waitFor(() => {
      expect(requests.find((request) => request.path.endsWith("/snapshot-new/approve"))?.body).toBeUndefined();
    });
  });

  it("says what a snapshot was trained on", async () => {
    const trained = {
      ...snapshots[0]!,
      metrics: {
        ...snapshots[0]!.metrics,
        trainingSources: { judgments: 4, replayForecasts: 176, groups: 28 },
      },
    };
    withCalibrationSnapshots([trained], snapshotDetail(trained));

    renderAt("/calibration");

    expect(
      await screen.findByText("4 resolved judgments and 176 replayed forecasts, from 28 markets and events"),
    ).toBeVisible();
  });

  it("says how far market prices are trusted", async () => {
    const fitted = {
      ...snapshotDetail(snapshots[0]!),
      marketPriorParams: { trustSlope: 0.84, trustIntercept: 0.02, fitted: true, sampleSize: 180 },
    };
    withCalibrationSnapshots([snapshots[0]], fitted);

    renderAt("/calibration");

    expect(await screen.findByText(/slope 0\.84 fitted on 180 benchmark prices/i)).toBeVisible();
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
