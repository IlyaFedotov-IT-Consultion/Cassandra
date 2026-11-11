import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { JudgmentRecordDetails } from "../src/api";
import {
  buildEnsembleSpread,
  buildEvidenceFlow,
  buildForecastPath,
  EnsembleSpreadChart,
  EvidenceFlowDiagram,
  ForecastHistoryChart,
  ForecastPathChart,
  ReliabilityChart,
} from "../src/components/charts";

type Trace = NonNullable<JudgmentRecordDetails["verdictTrace"]>;
type Opinion = Trace["judgeOpinions"][number];

const GPT = "openai/gpt-6.1-sol@high";
const OPUS = "anthropic/claude-opus-5.5@high";
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017@high";

function opinion(judgeName: string, overrides: Partial<Opinion> = {}): Opinion {
  return {
    judgeName,
    probability: 0.9,
    confidence: 0.8,
    evidenceStrength: "strong_for",
    rationale: "Reasoning.",
    evidenceIds: [],
    warnings: [],
    logBayesFactor: 3,
    baseWeight: 1 / 3,
    dependencyDiscount: 1,
    freshnessDecay: 0.5,
    effectiveLogOddsContribution: 0.5,
    missingEvidence: [],
    ...overrides,
  } as Opinion;
}

/** Mirrors a real live trace: three judges, a four-model ensemble, shrinkage, identity calibration. */
function liveTrace(overrides: Partial<Trace> = {}): Trace {
  const opinions = [
    opinion("official_records", {
      probability: 0.733,
      logBayesFactor: 1.5,
      effectiveLogOddsContribution: 0.245,
      evidenceIds: ["ev-bls", "ev-gov-2", "ev-gov-3"],
    }),
    opinion("community_signal", { probability: 0.96, effectiveLogOddsContribution: 0.5, evidenceIds: ["ev-reddit", "ev-bls"] }),
    opinion("open_web_research", { probability: 0.97, effectiveLogOddsContribution: 0.5, evidenceIds: ["ev-yahoo", "ev-mystery"] }),
  ];
  const samples = (judge: string) => [
    { model: GPT, probability: 0.95, evidenceStrength: "strong_for", rationale: `${judge}: BLS reports 3.7% headline CPI-U.` },
    { model: OPUS, probability: 0.9, evidenceStrength: "strong_for", rationale: `${judge}: the nowcast keeps a cushion.` },
    {
      model: DEEPSEEK,
      probability: 0.4,
      evidenceStrength: "strong_for",
      rationale: `${judge}: unsure.`,
      excluded: "label contradicts probability",
    },
  ];

  return {
    id: "trace-live",
    eventId: "event-cpi",
    evaluationTime: "2026-11-07T21:15:00Z",
    referenceClass: null,
    referenceClassFallback: null,
    priorProbability: 0.5,
    rawPosteriorProbability: 0.7764331373333982,
    preCalibrationProbability: 0.7734172273344894,
    finalProbability: 0.7734172273344894,
    confidenceLow: 0.726,
    confidenceHigh: 0.817,
    dependencyMatrix: [],
    disagreementShrinkage: 0.013888888888888888,
    judgeOpinions: opinions,
    weightBreakdown: opinions.map((entry) => ({
      source: entry.judgeName,
      weight: 1 / 3,
      details: { samples: samples(entry.judgeName) },
    })),
    ensembleMethod: "logarithmic_opinion_pool",
    calibrationMethod: "identity",
    uncertaintyMethod: "bootstrap",
    weightRegime: "cold_start",
    replayFidelity: "exact",
    conflicts: [],
    missingEvidence: [],
    citations: [
      { evidenceId: "ev-bls", title: "CPI release", url: "https://www.bls.gov/cpi", sourceFamily: "official", provider: "officialSearch" },
      { evidenceId: "ev-gov-2", title: "Gov 2", url: "https://www.gov.example/2", sourceFamily: "official", provider: "governmentSearch" },
      { evidenceId: "ev-gov-3", title: "Gov 3", url: "https://www.gov.example/3", sourceFamily: "official", provider: "governmentSearch" },
      { evidenceId: "ev-reddit", title: "Thread", url: "https://reddit.example/t", sourceFamily: "community", provider: "communitySearch" },
      { evidenceId: "ev-yahoo", title: "Yahoo", url: "https://finance.yahoo.example/a", sourceFamily: "web" },
    ],
    cacheEvents: [],
    pipelineStages: [
      {
        stage: "retrieval",
        status: "completed",
        details: {
          evidenceCount: 31,
          providers: [
            { name: "officialSearch", rawCount: 7, error: null },
            { name: "governmentSearch", rawCount: 13, error: null },
            { name: "communitySearch", rawCount: 12, error: null },
            { name: "web", rawCount: 11, error: null },
            { name: "polymarketClob", rawCount: 0, error: "upstream timeout" },
          ],
        },
      },
      { stage: "relevance_rating", status: "completed", details: { rated: 17, kept: 12, threshold: 4 } },
      { stage: "aggregation", status: "completed", details: { marketPriorUsed: false } },
    ],
    modelVersion: `ensemble[${GPT},${OPUS},${DEEPSEEK}]`,
    weightVersion: "snapshot-1",
    calibrationVersion: "snapshot-1",
    status: "completed",
    ...overrides,
  } as Trace;
}

const logit = (p: number) => Math.log(p / (1 - p));

describe("forecast path", () => {
  it("walks from the prior through each judge's pull, shrinkage and calibration to the final forecast", () => {
    const steps = buildForecastPath(liveTrace());

    expect(steps.map((step) => step.kind)).toEqual(["prior", "judge", "judge", "judge", "shrinkage", "calibration", "final"]);
    expect(steps[0]).toMatchObject({ label: "Prior", from: 0.5, to: 0.5 });
    // Largest pull first, then each step starts where the previous one ended.
    expect(steps.slice(1, 4).map((step) => step.label)).toEqual(["Community signal", "Open web research", "Official records"]);
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]!.from).toBeCloseTo(steps[index - 1]!.to, 9);
    }
    expect(steps[3]!.to).toBeCloseTo(0.7764331373333982, 6);
    expect(steps[4]!.to).toBeCloseTo(0.7734172273344894, 9);
    expect(steps[4]!.logOdds).toBeCloseTo(-0.013888888888888888 * 1.245, 6);
    expect(steps[5]).toMatchObject({ logOdds: 0 });
    expect(steps[5]!.detail).toMatch(/no recalibration/i);
    expect(steps[6]!.to).toBe(0.7734172273344894);
  });

  it("explains each judge's pull with the judge's own forecast and its weighting", () => {
    const official = buildForecastPath(liveTrace()).find((step) => step.label === "Official records")!;

    expect(official.logOdds).toBeCloseTo(0.245, 9);
    expect(official.detail).toContain("73.3%");
    expect(official.detail).toMatch(/freshness 0\.50/);
  });

  it("adds an explicit step when the recorded raw posterior differs from the judges' pulls", () => {
    const steps = buildForecastPath(liveTrace({ rawPosteriorProbability: 0.9 }));
    const adjustment = steps.find((step) => step.kind === "adjustment");

    expect(adjustment).toBeDefined();
    expect(adjustment!.to).toBeCloseTo(0.9, 9);
    expect(adjustment!.logOdds).toBeCloseTo(logit(0.9) - 1.245, 6);
  });

  it("derives the shrunk value when an older trace has no pre-calibration probability", () => {
    const steps = buildForecastPath(liveTrace({ preCalibrationProbability: null }));
    const shrinkage = steps.find((step) => step.kind === "shrinkage")!;
    const expected = (1 - 0.013888888888888888) * logit(0.7764331373333982);

    expect(logit(shrinkage.to)).toBeCloseTo(expected, 6);
  });

  it("switches between a log-odds and a probability scale", async () => {
    const user = userEvent.setup();
    render(<ForecastPathChart steps={buildForecastPath(liveTrace())} />);

    const chart = screen.getByRole("group", { name: /how the forecast moved/i });
    expect(within(chart).getAllByRole("listitem")).toHaveLength(7);
    const logOdds = screen.getByRole("button", { name: "Log-odds" });
    const probability = screen.getByRole("button", { name: "Probability" });
    expect(logOdds).toHaveAttribute("aria-pressed", "true");
    expect(within(chart).getByText("99%")).toBeInTheDocument();

    await user.click(probability);

    expect(probability).toHaveAttribute("aria-pressed", "true");
    expect(logOdds).toHaveAttribute("aria-pressed", "false");
    expect(within(chart).getByText("100%")).toBeInTheDocument();
    expect(within(chart).queryByText("99%")).not.toBeInTheDocument();
  });

  it("reads out a step's explanation when it is focused", () => {
    render(<ForecastPathChart steps={buildForecastPath(liveTrace())} />);

    fireEvent.focus(screen.getByRole("listitem", { name: /official records/i }));

    expect(screen.getByRole("status")).toHaveTextContent(/73\.3%/);
  });

  it("offers every step as a table", async () => {
    const user = userEvent.setup();
    render(<ForecastPathChart steps={buildForecastPath(liveTrace())} />);

    await user.click(screen.getByText("Show as table"));

    const table = screen.getByRole("table", { name: /forecast steps/i });
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    expect(within(table).getByRole("row", { name: /community signal/i })).toHaveTextContent("+0.50");
  });
});

describe("model agreement", () => {
  it("keeps each model on the colour slot of its place in the ensemble", () => {
    const { models, rows } = buildEnsembleSpread(liveTrace());

    expect(models.map((model) => [model.label, model.slot])).toEqual([
      ["gpt-6.1-sol", 1],
      ["claude-opus-5.5", 2],
      ["deepseek-v4.1-flash-1017", 3],
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Official records", "Community signal", "Open web research"]);
    expect(rows[0]!.samples.map((sample) => sample.slot)).toEqual([1, 2, 3]);
  });

  it("never invents a fifth colour: later models share the neutral slot", () => {
    const extra = ["a/m5@high", "b/m6@high"];
    const trace = liveTrace({ modelVersion: `ensemble[${GPT},${OPUS},${DEEPSEEK},x/m4@high,${extra.join(",")}]` });

    const { models } = buildEnsembleSpread(trace);

    expect(models.map((model) => model.slot)).toEqual([1, 2, 3, 4, 0, 0]);
  });

  it("highlights one model across every judge from the legend", async () => {
    const user = userEvent.setup();
    const { models, rows } = buildEnsembleSpread(liveTrace());
    render(<EnsembleSpreadChart models={models} rows={rows} finalProbability={0.773} />);

    const opus = screen.getByRole("button", { name: "claude-opus-5.5" });
    await user.click(opus);

    expect(opus).toHaveAttribute("aria-pressed", "true");
    const opusDots = screen.getAllByRole("button", { name: /^claude-opus-5\.5 for/ });
    const gptDots = screen.getAllByRole("button", { name: /^gpt-6\.1-sol for/ });
    expect(opusDots.every((dot) => dot.getAttribute("data-state") === "active")).toBe(true);
    expect(gptDots.every((dot) => dot.getAttribute("data-state") === "dimmed")).toBe(true);

    await user.click(opus);
    expect(opus).toHaveAttribute("aria-pressed", "false");
    expect(gptDots.every((dot) => dot.getAttribute("data-state") === "idle")).toBe(true);
  });

  it("marks excluded samples and shows a sample's reasoning on focus", () => {
    const { models, rows } = buildEnsembleSpread(liveTrace());
    render(<EnsembleSpreadChart models={models} rows={rows} finalProbability={0.773} />);

    const excluded = screen.getByRole("button", { name: /^deepseek-v4\.1-flash-1017 for official records/i });
    expect(excluded).toHaveAccessibleName(/excluded/i);

    fireEvent.focus(screen.getByRole("button", { name: /^gpt-6\.1-sol for official records/i }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(/BLS reports 3\.7% headline CPI-U/);
    expect(screen.getByText("Final 77.3%")).toBeInTheDocument();
  });

  it("moves between samples with the arrow keys", () => {
    const { models, rows } = buildEnsembleSpread(liveTrace());
    render(<EnsembleSpreadChart models={models} rows={rows} finalProbability={0.773} />);
    const [first, second] = screen.getAllByRole("button", { name: / for /i });

    first!.focus();
    fireEvent.keyDown(first!, { key: "ArrowRight" });

    expect(second).toHaveFocus();
    expect(first).toHaveAttribute("tabindex", "-1");
    expect(second).toHaveAttribute("tabindex", "0");
  });
});

describe("evidence flow", () => {
  it("traces kept evidence from each provider to the judges that read it", () => {
    const flow = buildEvidenceFlow(liveTrace());

    expect(flow.stages.map((stage) => [stage.label, stage.count])).toEqual([
      ["Retrieved", 43],
      ["Collected", 31],
      ["Rated", 17],
      ["Kept", 12],
    ]);
    const government = flow.providers.find((provider) => provider.key === "governmentSearch")!;
    expect(government).toMatchObject({ label: "Government Search", retrieved: 13, kept: 2, error: null });
    expect(flow.providers.find((provider) => provider.key === "polymarketClob")).toMatchObject({
      kept: 0,
      error: "upstream timeout",
    });
    expect(flow.links).toContainEqual({ provider: "governmentSearch", judge: "official_records", count: 2 });
    expect(flow.links).toContainEqual({ provider: "officialSearch", judge: "community_signal", count: 1 });
    // A citation without a provider falls back to its source family; an uncited id is unrecorded.
    expect(flow.links).toContainEqual({ provider: "web", judge: "open_web_research", count: 1 });
    expect(flow.links).toContainEqual({ provider: "unrecorded", judge: "open_web_research", count: 1 });
    expect(flow.judges.map((judge) => [judge.label, judge.read])).toEqual([
      ["Official records", 3],
      ["Community signal", 2],
      ["Open web research", 2],
    ]);
  });

  it("highlights a provider's links and reads out where its evidence went", () => {
    render(<EvidenceFlowDiagram flow={buildEvidenceFlow(liveTrace())} />);

    fireEvent.focus(screen.getByRole("button", { name: /^government search: 13 retrieved, 2 kept/i }));

    expect(screen.getByRole("status")).toHaveTextContent(/official records \(2\)/i);
    const links = screen.getAllByTestId("flow-link");
    const active = links.filter((link) => link.getAttribute("data-state") === "active");
    expect(active.map((link) => link.getAttribute("aria-label"))).toEqual([
      "2 items from Government Search read by Official records",
    ]);
    expect(links.filter((link) => link.getAttribute("data-state") === "muted").length).toBe(links.length - 1);
  });

  it("lists every link in a table", async () => {
    const user = userEvent.setup();
    render(<EvidenceFlowDiagram flow={buildEvidenceFlow(liveTrace())} />);

    await user.click(screen.getByText("Show as table"));

    const table = screen.getByRole("table", { name: /evidence by provider/i });
    expect(within(table).getByRole("row", { name: /government search/i })).toHaveTextContent("Official records (2)");
    expect(within(table).getByRole("row", { name: /polymarket clob/i })).toHaveTextContent("upstream timeout");
  });
});

describe("forecast history", () => {
  const points = [
    { id: "run-1", time: "2026-11-05T09:00:00Z", probability: 0.97, low: 0.9, high: 0.99 },
    { id: "run-2", time: "2026-11-07T11:20:00Z", probability: 0.994, low: 0.944, high: 0.996 },
  ];

  it("steps through runs with the arrow keys and opens one with Enter", () => {
    const onSelect = vi.fn();
    render(<ForecastHistoryChart points={points} onSelect={onSelect} />);
    const plot = screen.getByRole("group", { name: /forecast history/i });

    plot.focus();
    fireEvent.keyDown(plot, { key: "End" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("99.4%");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Range 94.4%–99.6%");

    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("97.0%");

    fireEvent.keyDown(plot, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("run-1");
  });

  it("opens a run when its point is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ForecastHistoryChart points={points} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /forecast 99\.4%/i }));

    expect(onSelect).toHaveBeenCalledWith("run-2");
  });

  it("marks how the event resolved", () => {
    render(
      <ForecastHistoryChart points={points} outcome={{ resolvedValue: true, resolvedAt: "2026-11-30T00:00:00Z" }} />,
    );

    expect(screen.getByText("Resolved Yes")).toBeInTheDocument();
  });
});

describe("reliability", () => {
  it("hides and shows a baseline from the legend without recolouring the others", async () => {
    const user = userEvent.setup();
    render(
      <ReliabilityChart
        series={[
          { key: "base_rate_only", label: "Base rate only", slot: 1, bins: [{ predicted: 0.5, observed: 0.5, count: 4 }] },
          { key: "polymarket_only", label: "Polymarket only", slot: 2, bins: [{ predicted: 0.2, observed: 0, count: 2 }] },
        ]}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Base rate only" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("img", { name: /^base rate only: predicted/i })).toHaveLength(1);

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryAllByRole("img", { name: /^base rate only: predicted/i })).toHaveLength(0);
    expect(screen.getByRole("img", { name: /^polymarket only: predicted/i })).toHaveAttribute(
      "data-slot",
      "2",
    );
  });
});
