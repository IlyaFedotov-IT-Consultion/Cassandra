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
    let importedBenchmarkSetId: string | null = null;
    const runtimeEvents = [
      {
        judgmentId: "judgment-1",
        eventId: "event-1",
        judgmentStatus: "completed",
        finalProbability: 0.63,
        entry: {
          timestamp: "2026-01-03T00:01:00Z",
          level: "info",
          stage: "evidence",
          message: "Evidence collection finished.",
          details: {
            evidenceCount: 9,
            providerRuns: [
              {
                providerName: "officialSearch",
                rawCount: 3,
                normalizedCount: 3,
                cacheStatus: "miss",
                error: null,
              },
            ],
          },
        },
      },
      {
        judgmentId: "judgment-1",
        eventId: "event-1",
        judgmentStatus: "completed",
        finalProbability: 0.63,
        entry: {
          timestamp: "2026-01-03T00:00:00Z",
          level: "info",
          stage: "queue",
          message: "Judgment was queued for background processing.",
          details: {
            eventId: "event-1",
          },
        },
      },
    ] as const;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const parsedUrl = new URL(url, "http://localhost");

      if (method === "GET" && url.endsWith("/health")) {
        return createResponse({
          status: "ok",
          adapterMode: "live",
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

      if (method === "GET" && (url.endsWith("/judgments") || url.includes("/judgments?eventId="))) {
        return createResponse([
          {
            id: "judgment-1",
            eventId: "event-1",
            status: "completed",
            executionLog: runtimeEvents.map((item) => item.entry),
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

      if (method === "GET" && parsedUrl.pathname === "/runtime") {
        let filtered = [...runtimeEvents];
        const search = parsedUrl.searchParams.get("search")?.toLowerCase() ?? "";
        const judgmentStatus = parsedUrl.searchParams.get("judgmentStatus");
        const stage = parsedUrl.searchParams.get("stage");
        const level = parsedUrl.searchParams.get("level");
        const limit = Number(parsedUrl.searchParams.get("limit") ?? "");

        if (judgmentStatus) {
          filtered = filtered.filter((item) => item.judgmentStatus === judgmentStatus);
        }

        if (stage) {
          filtered = filtered.filter((item) => item.entry.stage === stage);
        }

        if (level) {
          filtered = filtered.filter((item) => item.entry.level === level);
        }

        if (search) {
          filtered = filtered.filter((item) =>
            [
              item.judgmentId,
              item.eventId,
              item.entry.message,
              JSON.stringify(item.entry.details),
            ]
              .join(" ")
              .toLowerCase()
              .includes(search),
          );
        }

        if (Number.isFinite(limit) && limit > 0) {
          filtered = filtered.slice(0, limit);
        }

        return createResponse(filtered);
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
          executionLog: [
            {
              timestamp: "2026-01-03T00:00:00Z",
              level: "info",
              stage: "queue",
              message: "Judgment was queued for background processing.",
              details: {
                eventId: "event-1",
              },
            },
            {
              timestamp: "2026-01-03T00:01:00Z",
              level: "info",
              stage: "evidence",
              message: "Evidence collection finished.",
              details: {
                evidenceCount: 9,
                providerRuns: [
                  {
                    providerName: "officialSearch",
                    rawCount: 3,
                    normalizedCount: 3,
                    cacheStatus: "miss",
                    error: null,
                  },
                ],
              },
            },
          ],
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

      if (method === "GET" && url.endsWith("/judgments/judgment-failed")) {
        return createResponse({
          id: "judgment-failed",
          eventId: "event-1",
          status: "failed",
          verdictTrace: null,
          executionLog: [
            {
              timestamp: "2026-01-03T00:10:00Z",
              level: "info",
              stage: "run",
              message: "Judgment worker started.",
              details: {
                adapterMode: "live",
              },
            },
            {
              timestamp: "2026-01-03T00:11:00Z",
              level: "error",
              stage: "run",
              message: "Judgment run failed.",
              details: {
                error: "Judge service returned invalid response",
              },
            },
          ],
          createdAt: "2026-01-03T00:10:00Z",
          updatedAt: "2026-01-03T00:11:00Z",
          judgeOpinions: [],
        });
      }

      if (method === "GET" && url.endsWith("/judgments/judgment-insufficient")) {
        return createResponse({
          id: "judgment-insufficient",
          eventId: "event-1",
          status: "insufficient_evidence",
          executionLog: [
            {
              timestamp: "2026-01-03T00:10:00Z",
              level: "warn",
              stage: "coverage",
              message: "Live evidence coverage was too weak for a normal completed verdict.",
              details: {
                usableCitationCount: 1,
                hasEnoughCitationCoverage: false,
              },
            },
          ],
          verdictTrace: {
            id: "trace-insufficient",
            eventId: "event-1",
            evaluationTime: "2026-01-03T00:00:00Z",
            referenceClass: "product_launch",
            referenceClassFallback: null,
            priorProbability: 0.42,
            rawPosteriorProbability: 0.5,
            finalProbability: 0.5,
            confidenceLow: 0.44,
            confidenceHigh: 0.56,
            dependencyMatrix: [],
            disagreementShrinkage: 0.02,
            judgeOpinions: [
              {
                judgeName: "official_records",
                probability: 0.5,
                confidence: 0.55,
                evidenceStrength: "neutral",
                rationale: "Coverage is too thin to move off the base rate.",
                evidenceIds: [],
                warnings: ["Coverage is limited."],
                logBayesFactor: 0,
                baseWeight: 0.4,
                dependencyDiscount: 1,
                freshnessDecay: 1,
                effectiveLogOddsContribution: 0,
                missingEvidence: ["Independent confirmation"],
              },
            ],
            weightBreakdown: [
              {
                source: "official_records",
                weight: 0.4,
                details: {},
              },
            ],
            ensembleMethod: "logarithmic_opinion_pool",
            calibrationMethod: "identity",
            uncertaintyMethod: "bootstrap",
            weightRegime: "warming",
            replayFidelity: "exact",
            conflicts: [],
            missingEvidence: [
              {
                claim: "Independent confirmation of the launch timeline",
                sourceFamily: "web",
                reason: "Only one source family produced usable evidence.",
              },
            ],
            citations: [
              {
                title: "Single source report",
                url: "https://example.com/single-source",
                sourceFamily: "official",
              },
            ],
            cacheEvents: [
              {
                layer: "judge_output",
                target: "panel",
                status: "miss",
              },
            ],
            modelVersion: "judge-v1",
            weightVersion: "weights-v1",
            calibrationVersion: "cal-v1",
            status: "insufficient_evidence",
          },
          createdAt: "2026-01-03T00:10:00Z",
          updatedAt: "2026-01-03T00:11:00Z",
          judgeOpinions: [
            {
              id: "opinion-insufficient",
              judgmentId: "judgment-insufficient",
              judgeName: "official_records",
              probability: 0.5,
              confidence: 0.55,
              evidenceStrength: "neutral",
              rationale: "Coverage is too thin to move off the base rate.",
              evidenceIds: [],
              warnings: ["Coverage is limited."],
              logBayesFactor: 0,
              baseWeight: 0.4,
              dependencyDiscount: 1,
              freshnessDecay: 1,
              effectiveLogOddsContribution: 0,
              missingEvidence: ["Independent confirmation"],
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
            executionLog: [],
            createdAt: "2026-01-03T00:10:00Z",
            updatedAt: "2026-01-03T00:10:00Z",
            judgeOpinions: [],
          },
          {
            status: 202,
          },
        );
      }

      if (method === "POST" && url.endsWith("/events")) {
        const body =
          init?.body && typeof init.body === "string"
            ? (JSON.parse(init.body) as { question?: string })
            : {};

        if (body.question === "Fail event creation") {
          return createResponse(
            {
              error: "Question rejected by policy",
            },
            {
              status: 400,
            },
          );
        }

        return createResponse(
          {
            id: "event-new",
            question: body.question ?? "New event",
            resolutionCriteria: "Launch must be publicly announced.",
            deadline: "2026-12-31T23:59:59Z",
            status: "draft",
            entities: ["Example Corp"],
            referenceClass: null,
            marketSymbols: [],
            polymarketMarketId: null,
            createdAt: "2026-01-03T00:10:00Z",
            updatedAt: "2026-01-03T00:10:00Z",
          },
          {
            status: 201,
          },
        );
      }

      if (method === "GET" && url.endsWith("/evaluation/benchmark-sets")) {
        return createResponse(
          importedBenchmarkSetId
            ? [
                {
                  benchmarkSetId: importedBenchmarkSetId,
                  marketCount: 3,
                  earliestResolvedAt: "2026-06-17T18:00:00Z",
                  latestResolvedAt: "2026-08-28T16:00:00Z",
                  themes: ["macro", "policy", "technology"],
                },
              ]
            : [],
        );
      }

      if (method === "GET" && url.includes("/evaluation/benchmark-sets/") && url.endsWith("/markets")) {
        const benchmarkSetId = decodeURIComponent(
          url.slice(url.indexOf("/evaluation/benchmark-sets/") + "/evaluation/benchmark-sets/".length, -"/markets".length),
        );

        if (!importedBenchmarkSetId || benchmarkSetId !== importedBenchmarkSetId) {
          return createResponse([]);
        }

        return createResponse([
          {
            id: "fixture-market-fed-hold",
            benchmarkSetId,
            title: "Will the Fed hold rates steady at the next FOMC meeting?",
            resolutionCriteria:
              "Resolves Yes if the target range is unchanged at the next scheduled FOMC decision.",
            theme: "macro",
            volume: 245000,
            liquidity: 68000,
            resolvedAt: "2026-06-17T18:00:00Z",
            resolvedValue: true,
            marketUrl: "https://polymarket.com/event/fed-hold-next-fomc",
          },
          {
            id: "fixture-market-eu-fine",
            benchmarkSetId,
            title: "Will the EU fine Example Tech over antitrust conduct before July 2026?",
            resolutionCriteria:
              "Resolves Yes if the European Commission announces a formal monetary penalty before July 1, 2026.",
            theme: "policy",
            volume: 118000,
            liquidity: 41000,
            resolvedAt: "2026-06-21T09:00:00Z",
            resolvedValue: false,
            marketUrl: "https://polymarket.com/event/eu-antitrust-fine-example-tech",
          },
          {
            id: "fixture-market-launch-delay",
            benchmarkSetId,
            title: "Will Example Motors ship its new EV before September 2026?",
            resolutionCriteria:
              "Resolves Yes if customer deliveries of the announced EV begin before September 1, 2026.",
            theme: "technology",
            volume: 196000,
            liquidity: 53000,
            resolvedAt: "2026-08-28T16:00:00Z",
            resolvedValue: true,
            marketUrl: "https://polymarket.com/event/example-motors-ev-shipments",
          },
        ]);
      }

      if (method === "POST" && url.endsWith("/evaluation/benchmarks/import/polymarket")) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        importedBenchmarkSetId = payload.benchmarkSetId || "polymarket_recent_resolved";

        return createResponse(
          {
            imported: 3,
            markets: [
              {
                id: "fixture-market-fed-hold",
                benchmarkSetId: importedBenchmarkSetId,
                title: "Will the Fed hold rates steady at the next FOMC meeting?",
                resolutionCriteria:
                  "Resolves Yes if the target range is unchanged at the next scheduled FOMC decision.",
                theme: "macro",
                volume: 245000,
                liquidity: 68000,
                resolvedAt: "2026-06-17T18:00:00Z",
                resolvedValue: true,
                marketUrl: "https://polymarket.com/event/fed-hold-next-fomc",
              },
              {
                id: "fixture-market-eu-fine",
                benchmarkSetId: importedBenchmarkSetId,
                title: "Will the EU fine Example Tech over antitrust conduct before July 2026?",
                resolutionCriteria:
                  "Resolves Yes if the European Commission announces a formal monetary penalty before July 1, 2026.",
                theme: "policy",
                volume: 118000,
                liquidity: 41000,
                resolvedAt: "2026-06-21T09:00:00Z",
                resolvedValue: false,
                marketUrl: "https://polymarket.com/event/eu-antitrust-fine-example-tech",
              },
              {
                id: "fixture-market-launch-delay",
                benchmarkSetId: importedBenchmarkSetId,
                title: "Will Example Motors ship its new EV before September 2026?",
                resolutionCriteria:
                  "Resolves Yes if customer deliveries of the announced EV begin before September 1, 2026.",
                theme: "technology",
                volume: 196000,
                liquidity: 53000,
                resolvedAt: "2026-08-28T16:00:00Z",
                resolvedValue: true,
                marketUrl: "https://polymarket.com/event/example-motors-ev-shipments",
              },
            ],
          },
          {
            status: 201,
          },
        );
      }

      if (method === "GET" && url.endsWith("/evaluation/runs")) {
        return createResponse([
          {
            id: "run-1",
            benchmarkSetId: "benchmark-set-1",
            cutoffs: ["30d"],
            baselines: ["model_with_polymarket"],
            overallMetrics: {
              benchmarkCount: 1,
              predictionCount: 4,
              byBaseline: {
                model_with_polymarket: {
                  brierScore: 0.19,
                  logLoss: 0.48,
                  averageAbsoluteError: 0.21,
                  winRateVsPolymarket: 0,
                  sampleSize: 4,
                },
              },
            },
            replayFidelity: "exact",
            leakageWarnings: [],
            createdAt: "2026-01-02T00:00:00Z",
          },
        ]);
      }

      if (method === "POST" && url.endsWith("/evaluation/runs")) {
        return createResponse(
          {
            id: "run-new",
            benchmarkSetId: importedBenchmarkSetId ?? "benchmark-set-1",
            cutoffs: ["30d"],
            baselines: ["model_with_polymarket"],
            overallMetrics: {
              benchmarkCount: 1,
              predictionCount: 4,
              byBaseline: {
                model_with_polymarket: {
                  brierScore: 0.21,
                  logLoss: 0.50,
                  averageAbsoluteError: 0.23,
                  winRateVsPolymarket: 0,
                  sampleSize: 4,
                },
              },
            },
            sliceResults: [],
            replayFidelity: "exact",
            leakageWarnings: [],
            createdAt: "2026-01-04T00:00:00Z",
          },
          {
            status: 201,
          },
        );
      }

      if (method === "GET" && url.endsWith("/evaluation/runs/run-1")) {
        return createResponse({
          id: "run-1",
          benchmarkSetId: "benchmark-set-1",
          cutoffs: ["30d"],
          baselines: ["model_with_polymarket"],
          overallMetrics: {
            benchmarkCount: 1,
            predictionCount: 4,
            byBaseline: {
              model_with_polymarket: {
                brierScore: 0.19,
                logLoss: 0.48,
                averageAbsoluteError: 0.21,
                winRateVsPolymarket: 0,
                sampleSize: 4,
              },
            },
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
    expect(screen.getByText(/workspace mode/i)).toBeVisible();
    expect(screen.getByText(/^Live$/i)).toBeVisible();
    expect(screen.getByText(/Will Example Corp launch Product X/i)).toBeVisible();
    expect(screen.getAllByText("63.0%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/evidence collection finished/i).length).toBeGreaterThan(0);
  });

  it("renders the structured judgment trace view", async () => {
    renderApp(["/judgments/judgment-1"]);

    expect(await screen.findByRole("heading", { name: /judgment trace/i })).toBeVisible();
    expect(screen.getByRole("link", { name: /back to judgments/i })).toHaveAttribute("href", "/judgments");
    expect(screen.getAllByText("63.0%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Official release indicates launch readiness/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Web chatter remains less certain/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Exact GA date is not independently confirmed/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: /supporting citations/i })).toBeVisible();
    expect(screen.getByRole("link", { name: /Example Corp release/i })).toHaveAttribute(
      "href",
      "https://example.com/release",
    );
    expect(screen.getByRole("heading", { name: /execution logs/i })).toBeVisible();
    expect(screen.getByText(/evidence collection finished/i)).toBeVisible();
    expect(screen.getByText(/officialSearch/i)).toBeVisible();
  });

  it("shows a failure-specific state when a judgment run fails without a trace", async () => {
    renderApp(["/judgments/judgment-failed"]);

    expect(await screen.findByRole("heading", { name: /judgment trace/i })).toBeVisible();
    expect(screen.getByText(/judgment failed/i)).toBeVisible();
    expect(screen.getAllByText(/failed before a complete trace could be persisted/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/trace unavailable/i)).toBeVisible();
    expect(screen.getByText(/judge service returned invalid response/i)).toBeVisible();
  });

  it("shows an insufficient-evidence banner for degraded completed judgments", async () => {
    renderApp(["/judgments/judgment-insufficient"]);

    expect(await screen.findByRole("heading", { name: /judgment trace/i })).toBeVisible();
    expect(screen.getAllByText(/insufficient evidence/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/coverage was too weak/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/single source report/i)).toBeVisible();
  });

  it("shows watchlist candidate review and pre-fills the event seed panel", async () => {
    const user = userEvent.setup();

    renderApp(["/watchlists/watchlist-1"]);

    expect(await screen.findByRole("heading", { name: /watchlist detail/i })).toBeVisible();
    expect(screen.getByRole("link", { name: /back to watchlists/i })).toHaveAttribute("href", "/watchlists");
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
    expect(screen.getByRole("link", { name: /back to evaluation/i })).toHaveAttribute("href", "/evaluation");
    expect(screen.getByText(/benchmark-set-1/i)).toBeVisible();
    expect(screen.getAllByText(/technology/i).length).toBeGreaterThan(0);
    expect(screen.getByText("0.19")).toBeVisible();
    expect(screen.getByText("0.62")).toBeVisible();
  });

  it("imports benchmark sets from the evaluation workspace", async () => {
    const user = userEvent.setup();

    renderApp(["/evaluation"]);

    expect(await screen.findByRole("heading", { name: /evaluation workspace/i })).toBeVisible();
    expect(screen.getByText(/No benchmark sets yet/i)).toBeVisible();

    await user.type(screen.getByLabelText(/benchmark set id/i), "macro-replay-pack");
    await user.click(screen.getByRole("button", { name: /import benchmarks/i }));

    expect(await screen.findByText(/Imported 3 benchmark markets\./i)).toBeVisible();
    await waitFor(() => {
      expect(screen.getAllByText(/macro-replay-pack/i).length).toBeGreaterThan(0);
    });
    expect(
      await screen.findByText(/Will the Fed hold rates steady at the next FOMC meeting/i),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /run evaluation/i })).toBeEnabled();
  });

  it("adds a local return path on event detail views", async () => {
    renderApp(["/events/event-1"]);

    expect(await screen.findByRole("heading", { name: /event detail/i })).toBeVisible();
    expect(screen.getByRole("link", { name: /back to events/i })).toHaveAttribute("href", "/events");
    expect(screen.getByText(/evidence collection finished/i)).toBeVisible();
  });

  it("shows a runtime activity feed in the judgments workspace", async () => {
    renderApp(["/judgments"]);

    expect(await screen.findByRole("heading", { name: /judgments workspace/i })).toBeVisible();
    expect(screen.getByRole("heading", { name: /live activity feed/i })).toBeVisible();
    expect(screen.getAllByText(/evidence collection finished/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/judgment judgment-1/i).length).toBeGreaterThan(0);
  });

  it("filters the dedicated runtime console", async () => {
    const user = userEvent.setup();

    renderApp(["/runtime"]);

    expect(await screen.findByRole("heading", { name: /runtime console/i })).toBeVisible();
    expect(screen.getByText(/evidence collection finished/i)).toBeVisible();

    await user.selectOptions(screen.getByLabelText(/runtime stage filter/i), "queue");

    expect(screen.getByText(/judgment was queued for background processing/i)).toBeVisible();
    expect(screen.queryByText(/evidence collection finished/i)).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/runtime stage filter/i), "all");
    await user.type(screen.getByLabelText(/search runtime logs/i), "background processing");

    expect(screen.getByText(/judgment was queued for background processing/i)).toBeVisible();
    expect(screen.queryByText(/evidence collection finished/i)).not.toBeInTheDocument();
  });

  it("keeps create-event failures visible inside the dialog", async () => {
    const user = userEvent.setup();

    renderApp(["/events"]);

    expect(await screen.findByRole("heading", { name: /events workspace/i })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /create event/i }));

    const dialog = await screen.findByRole("dialog", { name: /create event/i });
    await user.type(within(dialog).getByLabelText(/^Question$/i), "Fail event creation");
    await user.type(within(dialog).getByLabelText(/^Deadline$/i), "2026-12-31T23:59");
    await user.type(within(dialog).getByLabelText(/^Resolution Criteria$/i), "Launch must be announced.");
    await user.type(within(dialog).getByLabelText(/^Entities$/i), "Example Corp");

    await user.click(within(dialog).getByRole("button", { name: /^Create event$/i }));

    expect(await within(dialog).findByText(/question rejected by policy/i)).toBeVisible();
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
