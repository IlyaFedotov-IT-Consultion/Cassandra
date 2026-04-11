import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

function createResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

function renderApp(initialEntries: string[] = ["/"]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 30_000,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("workspace app", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (method === "GET" && url.endsWith("/health")) {
        return createResponse({
          status: "ok",
        });
      }

      if (method === "GET" && url.endsWith("/ready")) {
        return createResponse({
          status: "ready",
        });
      }

      if (method === "GET" && url.endsWith("/events")) {
        return createResponse([
          {
            id: "event-1",
            question: "Will Example Corp launch Product X by 2026-12-31?",
            resolutionCriteria: "Launch must be publicly announced.",
            deadline: "2026-12-31T23:59:59Z",
            status: "active",
            entities: ["Example Corp", "Product X"],
            referenceClass: "product_launch",
            marketSymbols: ["EXMPL"],
            polymarketMarketId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
          },
        ]);
      }

      if (method === "GET" && url.endsWith("/watchlists")) {
        return createResponse([
          {
            id: "watchlist-1",
            name: "Biotech approvals",
            keywords: ["FDA", "approval"],
            jurisdictions: ["US"],
            cadence: "daily",
            sourceToggles: {
              official: true,
              government: true,
            },
            status: "active",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
          },
        ]);
      }

      if (method === "GET" && url.endsWith("/judgments")) {
        return createResponse([
          {
            id: "judgment-1",
            eventId: "event-1",
            status: "completed",
            verdictTrace: {
              id: "trace-1",
              eventId: "event-1",
              evaluationTime: "2026-01-03T00:00:00Z",
              referenceClass: "product_launch",
              referenceClassFallback: null,
              priorProbability: 0.42,
              rawPosteriorProbability: 0.6,
              finalProbability: 0.63,
              confidenceLow: 0.54,
              confidenceHigh: 0.71,
              dependencyMatrix: [
                {
                  judgeA: "official_records",
                  judgeB: "open_web_research",
                  jaccard: 0.28,
                },
              ],
              disagreementShrinkage: 0.12,
              judgeOpinions: [
                {
                  judgeName: "official_records",
                  probability: 0.67,
                  confidence: 0.78,
                  evidenceStrength: "moderate_for",
                  rationale: "Official release indicates launch readiness.",
                  evidenceIds: ["evidence-1"],
                  warnings: [],
                  logBayesFactor: 1.2,
                  baseWeight: 0.4,
                  dependencyDiscount: 0.92,
                  freshnessDecay: 1,
                  effectiveLogOddsContribution: 0.44,
                  missingEvidence: [],
                },
              ],
              weightBreakdown: [
                {
                  source: "official_records",
                  weight: 0.4,
                  details: {
                    family: "official",
                  },
                },
              ],
              ensembleMethod: "logarithmic_opinion_pool",
              calibrationMethod: "identity",
              uncertaintyMethod: "bootstrap",
              weightRegime: "warming",
              replayFidelity: "exact",
              conflicts: [
                {
                  judgeA: "official_records",
                  judgeB: "open_web_research",
                  reason: "Web chatter remains less certain than official signals.",
                  severity: "medium",
                },
              ],
              missingEvidence: [
                {
                  claim: "Exact GA date is not independently confirmed.",
                  sourceFamily: "official",
                  reason: "Only one primary source is available.",
                },
              ],
              citations: [
                {
                  title: "Example Corp release",
                  url: "https://example.com/release",
                  sourceFamily: "official",
                },
              ],
              cacheEvents: [
                {
                  layer: "judge_output",
                  target: "panel",
                  status: "hit",
                },
              ],
              modelVersion: "judge-v1",
              weightVersion: "weights-v1",
              calibrationVersion: "cal-v1",
              status: "completed",
            },
            createdAt: "2026-01-03T00:00:00Z",
            updatedAt: "2026-01-03T00:05:00Z",
          },
        ]);
      }

      if (method === "GET" && url.endsWith("/events/event-1")) {
        return createResponse({
          id: "event-1",
          question: "Will Example Corp launch Product X by 2026-12-31?",
          resolutionCriteria: "Launch must be publicly announced.",
          deadline: "2026-12-31T23:59:59Z",
          status: "active",
          entities: ["Example Corp", "Product X"],
          referenceClass: "product_launch",
          marketSymbols: ["EXMPL"],
          polymarketMarketId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        });
      }

      if (method === "GET" && url.endsWith("/watchlists/watchlist-1")) {
        return createResponse({
          id: "watchlist-1",
          name: "Biotech approvals",
          keywords: ["FDA", "approval"],
          jurisdictions: ["US"],
          cadence: "daily",
          sourceToggles: {
            official: true,
            government: true,
          },
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        });
      }

      if (method === "GET" && url.endsWith("/watchlists/watchlist-1/candidates")) {
        return createResponse([
          {
            id: "candidate-1",
            watchlistId: "watchlist-1",
            title: "Example Therapy receives FDA fast-track decision",
            description: "Potential approval catalyst for the next quarter.",
            supportingEvidenceIds: ["evidence-1"],
            clusterKey: "fda-fast-track",
            promotionStatus: "pending",
            candidateSignature: {
              topic: "approval",
            },
          },
        ]);
      }

      if (method === "GET" && url.endsWith("/judgments/judgment-1")) {
        return createResponse({
          id: "judgment-1",
          eventId: "event-1",
          status: "completed",
          verdictTrace: {
            id: "trace-1",
            eventId: "event-1",
            evaluationTime: "2026-01-03T00:00:00Z",
            referenceClass: "product_launch",
            referenceClassFallback: null,
            priorProbability: 0.42,
            rawPosteriorProbability: 0.6,
            finalProbability: 0.63,
            confidenceLow: 0.54,
            confidenceHigh: 0.71,
            dependencyMatrix: [
              {
                judgeA: "official_records",
                judgeB: "open_web_research",
                jaccard: 0.28,
              },
            ],
            disagreementShrinkage: 0.12,
            judgeOpinions: [
              {
                judgeName: "official_records",
                probability: 0.67,
                confidence: 0.78,
                evidenceStrength: "moderate_for",
                rationale: "Official release indicates launch readiness.",
                evidenceIds: ["evidence-1"],
                warnings: [],
                logBayesFactor: 1.2,
                baseWeight: 0.4,
                dependencyDiscount: 0.92,
                freshnessDecay: 1,
                effectiveLogOddsContribution: 0.44,
                missingEvidence: [],
              },
            ],
            weightBreakdown: [
              {
                source: "official_records",
                weight: 0.4,
                details: {
                  family: "official",
                },
              },
            ],
            ensembleMethod: "logarithmic_opinion_pool",
            calibrationMethod: "identity",
            uncertaintyMethod: "bootstrap",
            weightRegime: "warming",
            replayFidelity: "exact",
            conflicts: [
              {
                judgeA: "official_records",
                judgeB: "open_web_research",
                reason: "Web chatter remains less certain than official signals.",
                severity: "medium",
              },
            ],
            missingEvidence: [
              {
                claim: "Exact GA date is not independently confirmed.",
                sourceFamily: "official",
                reason: "Only one primary source is available.",
              },
            ],
            citations: [
              {
                title: "Example Corp release",
                url: "https://example.com/release",
                sourceFamily: "official",
              },
            ],
            cacheEvents: [
              {
                layer: "judge_output",
                target: "panel",
                status: "hit",
              },
            ],
            modelVersion: "judge-v1",
            weightVersion: "weights-v1",
            calibrationVersion: "cal-v1",
            status: "completed",
          },
          createdAt: "2026-01-03T00:00:00Z",
          updatedAt: "2026-01-03T00:05:00Z",
          judgeOpinions: [
            {
              id: "opinion-1",
              judgmentId: "judgment-1",
              judgeName: "official_records",
              probability: 0.67,
              confidence: 0.78,
              evidenceStrength: "moderate_for",
              rationale: "Official release indicates launch readiness.",
              evidenceIds: ["evidence-1"],
              warnings: [],
              logBayesFactor: 1.2,
              baseWeight: 0.4,
              dependencyDiscount: 0.92,
              freshnessDecay: 1,
              effectiveLogOddsContribution: 0.44,
              missingEvidence: [],
            },
          ],
        });
      }

      if (method === "POST" && url.endsWith("/judgments")) {
        return createResponse(
          {
            id: "judgment-new",
            eventId: "event-1",
            status: "queued",
            verdictTrace: null,
            createdAt: "2026-01-03T00:10:00Z",
            updatedAt: "2026-01-03T00:10:00Z",
            judgeOpinions: [],
          },
          {
            status: 202,
          },
        );
      }

      if (method === "GET" && url.endsWith("/evaluation/benchmark-sets")) {
        return createResponse([
          {
            benchmarkSetId: "benchmark-set-1",
            marketCount: 12,
            earliestResolvedAt: "2025-01-01T00:00:00Z",
            latestResolvedAt: "2025-12-31T00:00:00Z",
            themes: ["technology", "policy"],
          },
        ]);
      }

      if (method === "GET" && url.endsWith("/evaluation/runs")) {
        return createResponse([
          {
            id: "run-1",
            benchmarkSetId: "benchmark-set-1",
            cutoffs: ["30d"],
            baselines: ["model_with_polymarket"],
            overallMetrics: {
              brierScore: 0.19,
            },
            replayFidelity: "exact",
            leakageWarnings: [],
            createdAt: "2026-01-02T00:00:00Z",
          },
        ]);
      }

      if (method === "GET" && url.endsWith("/evaluation/runs/run-1")) {
        return createResponse({
          id: "run-1",
          benchmarkSetId: "benchmark-set-1",
          cutoffs: ["30d"],
          baselines: ["model_with_polymarket"],
          overallMetrics: {
            brierScore: 0.19,
          },
          sliceResults: [
            {
              sliceKey: "technology",
              baseline: "model_with_polymarket",
              brierScore: 0.17,
              logLoss: 0.48,
              averageAbsoluteError: 0.21,
              sampleSize: 12,
            },
          ],
          replayFidelity: "exact",
          leakageWarnings: [],
          createdAt: "2026-01-02T00:00:00Z",
        });
      }

      if (method === "GET" && url.endsWith("/evaluation/runs/run-1/predictions")) {
        return createResponse([
          {
            id: "prediction-1",
            evaluationRunId: "run-1",
            benchmarkMarketId: "market-1",
            baseline: "model_with_polymarket",
            cutoffAt: "2025-12-01T00:00:00Z",
            predictedProbability: 0.62,
            outcome: true,
            theme: "technology",
            horizon: "30d",
            sourceConfiguration: "default",
            metadata: {},
            createdAt: "2026-01-02T00:00:00Z",
          },
        ]);
      }

      if (method === "GET" && url.endsWith("/backtests/calibration-snapshots")) {
        return createResponse([
          {
            id: "snapshot-1",
            createdAt: "2026-01-02T00:00:00Z",
            trainingWindow: "all_time",
            metrics: {
              ece: 0.08,
            },
            weightRegime: "warming",
            resolvedOutcomeCount: 25,
            approved: false,
          },
        ]);
      }

      if (method === "GET" && url.endsWith("/backtests/calibration-snapshots/snapshot-1")) {
        return createResponse({
          id: "snapshot-1",
          createdAt: "2026-01-02T00:00:00Z",
          trainingWindow: "all_time",
          judgeWeights: {
            official_records: 0.5,
          },
          baseRateParams: {},
          marketPriorParams: {},
          calibrationParams: {
            method: "logistic",
          },
          onlineLearningParams: {},
          metrics: {
            ece: 0.08,
          },
          weightRegime: "warming",
          resolvedOutcomeCount: 25,
          approved: false,
        });
      }

      if (method === "GET" && url.endsWith("/backtests/calibration-snapshots/snapshot-2")) {
        return createResponse({
          id: "snapshot-2",
          createdAt: "2026-01-03T00:00:00Z",
          trainingWindow: "all_time",
          judgeWeights: {
            official_records: 0.55,
          },
          baseRateParams: {},
          marketPriorParams: {},
          calibrationParams: {
            method: "logistic",
          },
          onlineLearningParams: {},
          metrics: {
            ece: 0.05,
          },
          weightRegime: "steady",
          resolvedOutcomeCount: 120,
          approved: true,
        });
      }

      if (method === "POST" && url.endsWith("/backtests/retrain")) {
        return createResponse(
          {
            id: "snapshot-2",
            createdAt: "2026-01-03T00:00:00Z",
            trainingWindow: "all_time",
            judgeWeights: {
              official_records: 0.55,
            },
            baseRateParams: {},
            marketPriorParams: {},
            calibrationParams: {
              method: "logistic",
            },
            onlineLearningParams: {},
            metrics: {
              ece: 0.05,
            },
            weightRegime: "steady",
            resolvedOutcomeCount: 120,
            approved: true,
          },
          {
            status: 201,
          },
        );
      }

      return createResponse(
        {
          error: `Unhandled request: ${method} ${url}`,
        },
        {
          status: 404,
        },
      );
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the workspace shell and loads the events overview by default", async () => {
    renderApp(["/"]);

    expect(screen.getByRole("link", { name: "Events" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Watchlists" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Judgments" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Evaluation" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Calibration" })).toBeVisible();

    expect(await screen.findByRole("heading", { name: /events workspace/i })).toBeVisible();
    expect(screen.getByText(/Will Example Corp launch Product X/i)).toBeVisible();
    expect(screen.getAllByText("63.0%").length).toBeGreaterThan(0);
  });

  it("renders the structured judgment trace view", async () => {
    renderApp(["/judgments/judgment-1"]);

    expect(await screen.findByRole("heading", { name: /judgment trace/i })).toBeVisible();
    expect(screen.getAllByText("63.0%").length).toBeGreaterThan(0);
    expect(screen.getByText(/Official release indicates launch readiness/i)).toBeVisible();
    expect(screen.getByText(/Web chatter remains less certain/i)).toBeVisible();
    expect(screen.getByText(/Exact GA date is not independently confirmed/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /Example Corp release/i })).toHaveAttribute(
      "href",
      "https://example.com/release",
    );
  });

  it("shows watchlist candidate review and pre-fills the event seed panel", async () => {
    const user = userEvent.setup();

    renderApp(["/watchlists/watchlist-1"]);

    expect(await screen.findByRole("heading", { name: /watchlist detail/i })).toBeVisible();
    expect(screen.getByText(/Example Therapy receives FDA fast-track decision/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /seed event/i }));

    const dialog = await screen.findByRole("dialog", { name: /seed event from candidate/i });
    expect(within(dialog).getByDisplayValue(/Example Therapy receives FDA fast-track decision/i)).toBeVisible();
    expect(
      within(dialog).getByDisplayValue(/Potential approval catalyst for the next quarter/i),
    ).toBeVisible();
  });

  it("renders evaluation details and prediction tables", async () => {
    renderApp(["/evaluation/runs/run-1"]);

    expect(await screen.findByRole("heading", { name: /evaluation run/i })).toBeVisible();
    expect(screen.getByText(/benchmark-set-1/i)).toBeVisible();
    expect(screen.getAllByText(/technology/i).length).toBeGreaterThan(0);
    expect(screen.getByText("0.19")).toBeVisible();
    expect(screen.getByText("0.62")).toBeVisible();
  });

  it("loads calibration history and retrains a new snapshot", async () => {
    const user = userEvent.setup();

    renderApp(["/calibration"]);

    expect(await screen.findByRole("heading", { name: /calibration workspace/i })).toBeVisible();
    expect(screen.getByText(/snapshot-1/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /retrain snapshot/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/snapshot-2/i).length).toBeGreaterThan(0);
    });
  });
});
