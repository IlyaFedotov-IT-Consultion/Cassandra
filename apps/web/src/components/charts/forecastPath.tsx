import { useState } from "react";

import type { JudgmentRecordDetails } from "../../api";
import { formatDecimal, formatProbability, formatSignedDecimal, humanizeToken } from "../../format";
import { logit, SegmentedControl, sigmoid, TableView, useMeasuredWidth, useRovingFocus } from "./primitives";

type Trace = NonNullable<JudgmentRecordDetails["verdictTrace"]>;
type Opinion = Trace["judgeOpinions"][number];

export type ForecastPathStepKind = "prior" | "judge" | "adjustment" | "shrinkage" | "calibration" | "final";

export interface ForecastPathStep {
  key: string;
  kind: ForecastPathStepKind;
  label: string;
  /** Probability before and after the step. */
  from: number;
  to: number;
  /** The step's size in log-odds (to minus from). */
  logOdds: number;
  detail: string;
}

/** A recorded pooled forecast further than this (in log-odds) from the judges' sum gets its own step. */
const RECONCILE_TOLERANCE = 0.005;

function sourceCount(count: number) {
  return `${count} source${count === 1 ? "" : "s"}`;
}

/**
 * The aggregation, step by step, from the judge service's own formula:
 * pooled = logit(prior) + sum of each judge's effective pull; shrunk = (1 - s) * pooled + s * logit(prior);
 * final = calibration(shrunk). Each step starts where the previous one ended.
 */
export function buildForecastPath(trace: Trace, opinions: Opinion[] = trace.judgeOpinions): ForecastPathStep[] {
  const prior = trace.priorProbability;
  const marketUsed = trace.pipelineStages?.find((stage) => stage.stage === "aggregation")?.details.marketPriorUsed;
  const steps: ForecastPathStep[] = [
    {
      key: "prior",
      kind: "prior",
      label: "Prior",
      from: prior,
      to: prior,
      logOdds: 0,
      detail:
        marketUsed === true
          ? `Started at ${formatProbability(prior)}: the base rate blended with the market price.`
          : marketUsed === false
            ? `Started at ${formatProbability(prior)}: the base rate for this kind of question (no market price).`
            : `Started at ${formatProbability(prior)}.`,
    },
  ];

  let current = logit(prior);
  const ordered = [...opinions].sort(
    (left, right) => Math.abs(right.effectiveLogOddsContribution) - Math.abs(left.effectiveLogOddsContribution),
  );
  for (const opinion of ordered) {
    const label = humanizeToken(opinion.judgeName);
    const from = sigmoid(current);
    current += opinion.effectiveLogOddsContribution;
    steps.push({
      key: `judge-${opinion.judgeName}`,
      kind: "judge",
      label,
      from,
      to: sigmoid(current),
      logOdds: opinion.effectiveLogOddsContribution,
      detail:
        opinion.evidenceIds.length === 0
          ? `${label} had no cited evidence, so it did not move the forecast.`
          : `${label} judged ${formatProbability(opinion.probability)} (${humanizeToken(opinion.evidenceStrength).toLowerCase()}) from ${sourceCount(opinion.evidenceIds.length)}. ` +
            `Log Bayes factor ${formatSignedDecimal(opinion.logBayesFactor)}, weight ${formatDecimal(opinion.baseWeight)}, ` +
            `dependency discount ${formatDecimal(opinion.dependencyDiscount)}, freshness ${formatDecimal(opinion.freshnessDecay)}: ` +
            `a pull of ${formatSignedDecimal(opinion.effectiveLogOddsContribution)} log-odds.`,
    });
  }

  const pooled = logit(trace.rawPosteriorProbability);
  if (Math.abs(pooled - current) > RECONCILE_TOLERANCE) {
    steps.push({
      key: "adjustment",
      kind: "adjustment",
      label: "Other adjustments",
      from: sigmoid(current),
      to: trace.rawPosteriorProbability,
      logOdds: pooled - current,
      detail: "The recorded pooled forecast differs from the sum of the judges' pulls, for example in a trace from an older pipeline.",
    });
    current = pooled;
  }

  const shrinkage = trace.disagreementShrinkage;
  const shrunk = trace.preCalibrationProbability ?? sigmoid((1 - shrinkage) * current + shrinkage * logit(prior));
  steps.push({
    key: "shrinkage",
    kind: "shrinkage",
    label: "Disagreement shrinkage",
    from: sigmoid(current),
    to: shrunk,
    logOdds: logit(shrunk) - current,
    detail:
      shrinkage === 0
        ? "The judges agreed, so nothing was pulled back toward the prior."
        : `The judges disagreed, so the forecast was pulled ${formatDecimal(shrinkage * 100)}% of the way back toward the prior.`,
  });

  const final = trace.finalProbability;
  steps.push({
    key: "calibration",
    kind: "calibration",
    label: "Calibration",
    from: shrunk,
    to: final,
    logOdds: final === shrunk ? 0 : logit(final) - logit(shrunk),
    detail:
      trace.calibrationMethod === "identity"
        ? "No recalibration: the snapshot in use maps every forecast to itself."
        : `${humanizeToken(trace.calibrationMethod)} calibration moved ${formatProbability(shrunk)} to ${formatProbability(final)}.`,
  });
  steps.push({
    key: "final",
    kind: "final",
    label: "Final",
    from: final,
    to: final,
    logOdds: 0,
    detail: `Final forecast ${formatProbability(final)}, range ${formatProbability(trace.confidenceLow)}–${formatProbability(trace.confidenceHigh)}.`,
  });

  return steps;
}

type ScaleKind = "logit" | "linear";

const ROW_HEIGHT = 34;
/** Narrow layout: the step's name sits inside the plot, above its arrow. */
const COMPACT_ROW_HEIGHT = 46;
const COMPACT_BELOW = 480;
const LOGIT_TICKS = [0.001, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 0.999];
const LOGIT_TICKS_NARROW = [0.01, 0.5, 0.99];
const LINEAR_TICKS = [0, 0.25, 0.5, 0.75, 1];
const LINEAR_TICKS_NARROW = [0, 0.5, 1];

function tickLabel(value: number) {
  return value === 0.001 || value === 0.999 ? `${(value * 100).toFixed(1)}%` : `${Math.round(value * 100)}%`;
}

function describeStep(step: ForecastPathStep) {
  if (step.kind === "prior" || step.kind === "final") {
    return `${step.label}: ${formatProbability(step.to)}`;
  }
  if (step.logOdds === 0) {
    return `${step.label}: no change, ${formatProbability(step.to)}`;
  }
  return `${step.label}: ${formatSignedDecimal(step.logOdds)} log-odds, ${formatProbability(step.from)} to ${formatProbability(step.to)}`;
}

/**
 * The forecast's path from prior to final, one row per step. On the log-odds scale each
 * pull is drawn at its true, additive size; the probability scale shows where it sits.
 */
export function ForecastPathChart({ steps }: { steps: ForecastPathStep[] }) {
  const [scaleKind, setScaleKind] = useState<ScaleKind>("logit");
  const [focused, setFocused] = useState<number | null>(null);
  const [frameRef, frameWidth] = useMeasuredWidth<HTMLDivElement>(640);
  const [axisRef, width] = useMeasuredWidth<HTMLDivElement>(480);
  const roving = useRovingFocus<HTMLLIElement>(steps.length);
  const compact = frameWidth < COMPACT_BELOW;
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  const narrow = width < 260;

  const logits = steps.flatMap((step) => [logit(step.from), logit(step.to)]);
  const low = Math.max(Math.min(logit(0.01), Math.min(...logits) - 0.3), -7.5);
  const high = Math.min(Math.max(logit(0.99), Math.max(...logits) + 0.3), 7.5);
  // Room for half a tick label ("99.9%") at either end of the axis.
  const inset = 18;
  const toX = (probability: number) => {
    const share = scaleKind === "logit" ? (logit(probability) - low) / (high - low) : probability;
    return inset + Math.min(Math.max(share, 0), 1) * (width - inset * 2);
  };
  const ticks =
    scaleKind === "logit"
      ? (narrow ? LOGIT_TICKS_NARROW : LOGIT_TICKS).filter((tick) => logit(tick) >= low && logit(tick) <= high)
      : narrow
        ? LINEAR_TICKS_NARROW
        : LINEAR_TICKS;
  const last = steps.length - 1;

  return (
    <figure className="path-chart">
      <div className="path-chart__toolbar">
        <SegmentedControl
          label="Scale"
          value={scaleKind}
          onChange={setScaleKind}
          options={[
            { value: "logit", label: "Log-odds" },
            { value: "linear", label: "Probability" },
          ]}
        />
        <p className="helper-text">
          {scaleKind === "logit"
            ? "Each pull is drawn at its true size: on this scale the steps add up."
            : "Where the forecast sits on the plain 0–100% scale."}
        </p>
      </div>
      <div
        ref={frameRef}
        className={compact ? "path-chart__frame path-chart__frame--compact" : "path-chart__frame"}
        role="group"
        aria-label="How the forecast moved"
        onMouseLeave={() => setFocused(null)}
      >
        <div className="path-chart__row path-chart__row--axis" aria-hidden="true">
          {compact ? null : <span />}
          <div ref={axisRef} className="path-chart__cell">
            <svg className="path-chart__axis" width={width} height={20}>
              {ticks.map((tick) => (
                <text key={tick} className="chart__axis-label" x={toX(tick)} y={13} textAnchor="middle">
                  {tickLabel(tick)}
                </text>
              ))}
            </svg>
          </div>
          <span />
        </div>
        <ol className="path-chart__rows">
          {steps.map((step, index) => {
            const x0 = toX(step.from);
            const x1 = toX(step.to);
            const mid = compact ? rowHeight - 15 : rowHeight / 2;
            const direction = x1 >= x0 ? 1 : -1;
            const moves = Math.abs(x1 - x0) >= 3;
            return (
              <li
                key={step.key}
                className={`path-chart__row path-chart__row--${step.kind}`}
                data-state={focused === index ? "active" : "idle"}
                aria-label={describeStep(step)}
                {...roving.itemProps(index)}
                onFocus={() => setFocused(index)}
                onMouseEnter={() => setFocused(index)}
              >
                {compact ? null : <span className="path-chart__label">{step.label}</span>}
                <span className="path-chart__cell">
                  <svg className="path-chart__track" width={width} height={rowHeight} aria-hidden="true">
                    {ticks.map((tick) => (
                      <line key={tick} className="chart__grid" x1={toX(tick)} x2={toX(tick)} y1={0} y2={rowHeight} />
                    ))}
                    {index > 0 ? <line className="path-chart__connector" x1={x0} x2={x0} y1={0} y2={mid} /> : null}
                    {index < last ? <line className="path-chart__connector" x1={x1} x2={x1} y1={mid} y2={rowHeight} /> : null}
                    {compact ? (
                      <text className="path-chart__inline-label" x={4} y={13}>
                        {step.label}
                      </text>
                    ) : null}
                    {step.kind === "prior" ? (
                      <circle className="path-chart__start" cx={x1} cy={mid} r={4.5} />
                    ) : step.kind === "final" ? (
                      <circle className="path-chart__end" cx={x1} cy={mid} r={5.5} />
                    ) : moves ? (
                      <>
                        <line className="path-chart__step" x1={x0} x2={x1 - direction * 5} y1={mid} y2={mid} />
                        <polygon
                          className="path-chart__head"
                          points={`${x1},${mid} ${x1 - direction * 7},${mid - 4.5} ${x1 - direction * 7},${mid + 4.5}`}
                        />
                      </>
                    ) : (
                      <circle className="path-chart__still" cx={x1} cy={mid} r={3} />
                    )}
                  </svg>
                </span>
                <span className="path-chart__value">
                  <strong>{formatProbability(step.to)}</strong>
                  {step.kind === "prior" || step.kind === "final" ? null : (
                    <small>{step.logOdds === 0 ? "±0.00" : formatSignedDecimal(step.logOdds)}</small>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="chart-readout" role="status">
        {focused === null ? "Hover or focus a step to see why the forecast moved." : steps[focused]!.detail}
      </p>
      <TableView caption="Forecast steps">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col" className="data-table__number">
              Pull (log-odds)
            </th>
            <th scope="col" className="data-table__number">
              Forecast after
            </th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr key={step.key}>
              <th scope="row">{step.label}</th>
              <td className="data-table__number">
                {step.kind === "prior" || step.kind === "final" ? "n/a" : formatSignedDecimal(step.logOdds)}
              </td>
              <td className="data-table__number">{formatProbability(step.to)}</td>
            </tr>
          ))}
        </tbody>
      </TableView>
    </figure>
  );
}
