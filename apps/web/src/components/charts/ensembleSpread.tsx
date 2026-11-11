import { useState } from "react";

import type { JudgmentRecordDetails } from "../../api";
import { formatProbability, humanizeToken } from "../../format";
import { readSamples, shortModelName, splitRationale, type EnsembleSample } from "../trace";
import { ChartTooltip, percent, TableView, useMeasuredWidth, useRovingFocus, type TooltipState } from "./primitives";

type Trace = NonNullable<JudgmentRecordDetails["verdictTrace"]>;
type Opinion = Trace["judgeOpinions"][number];

export interface EnsembleModel {
  key: string;
  label: string;
  /** Categorical slot 1-4 by place in the ensemble; 0 is the shared neutral slot past the fourth. */
  slot: number;
}

export interface EnsembleSpreadSample extends EnsembleSample {
  label: string;
  slot: number;
}

export interface EnsembleSpreadRow {
  judgeName: string;
  label: string;
  /** The judge's own forecast, pooled from its included samples. */
  probability: number;
  samples: EnsembleSpreadSample[];
}

const CATEGORICAL_SLOTS = 4;

/** "ensemble[a,b,c]" -> ["a", "b", "c"]; a single model id -> [id]. */
export function parseEnsembleModels(modelVersion: string): string[] {
  const match = /^ensemble\[(.*)\]$/.exec(modelVersion.trim());
  const list = match ? match[1]!.split(",") : [modelVersion];
  return list.map((model) => model.trim()).filter(Boolean);
}

/**
 * Each judge's samples, one per ensemble model. A model keeps the colour of its place in
 * the ensemble on every judge (colour follows the entity); past the fourth, models share
 * the neutral slot instead of a generated hue.
 */
export function buildEnsembleSpread(
  trace: Trace,
  opinions: Opinion[] = trace.judgeOpinions,
): { models: EnsembleModel[]; rows: EnsembleSpreadRow[] } {
  const sampled = opinions.map((opinion) => ({ opinion, samples: readSamples(trace, opinion.judgeName) }));
  const keys = parseEnsembleModels(trace.modelVersion).filter((key) => key.includes("/"));
  for (const { samples } of sampled) {
    for (const sample of samples) {
      if (!keys.includes(sample.model)) {
        keys.push(sample.model);
      }
    }
  }
  const models = keys.map((key, index) => ({
    key,
    label: shortModelName(key),
    slot: index < CATEGORICAL_SLOTS ? index + 1 : 0,
  }));
  const slotOf = new Map(models.map((model) => [model.key, model]));

  const rows = sampled
    .filter(({ samples }) => samples.length > 0)
    .map(({ opinion, samples }) => ({
      judgeName: opinion.judgeName,
      label: humanizeToken(opinion.judgeName),
      probability: opinion.probability,
      samples: samples.map((sample) => ({
        ...sample,
        label: slotOf.get(sample.model)?.label ?? shortModelName(sample.model),
        slot: slotOf.get(sample.model)?.slot ?? 0,
      })),
    }));

  return { models, rows };
}

const ROW_HEIGHT = 58;
/** Tick labels on the first line, the final forecast's label on the second. */
const AXIS_HEIGHT = 44;
const INSET = 14;
const TICKS = [0, 0.25, 0.5, 0.75, 1];

function excerpt(text: string, limit = 180) {
  const clean = splitRationale(text).text.trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

function dotClass(slot: number, excluded: boolean) {
  const colour = slot === 0 ? "chart__dot--other" : `chart__dot--series-${slot}`;
  return `chart__dot ${colour}${excluded ? " chart__dot--hollow" : ""}`;
}

/**
 * Where every model's sample landed for each judge, against the judge's pooled forecast
 * (ink tick) and the final forecast (signal line). Excluded samples are hollow.
 */
export function EnsembleSpreadChart({
  models,
  rows,
  finalProbability,
}: {
  models: EnsembleModel[];
  rows: EnsembleSpreadRow[];
  finalProbability: number;
}) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [figureRef, width] = useMeasuredWidth<HTMLElement>(640);
  const marks = rows.flatMap((row, rowIndex) => row.samples.map((sample) => ({ row, rowIndex, sample })));
  const roving = useRovingFocus<SVGGElement>(marks.length);
  const height = AXIS_HEIGHT + rows.length * ROW_HEIGHT + 6;
  const x = (probability: number) => INSET + probability * (width - INSET * 2);
  const modelIndex = new Map(models.map((model, index) => [model.key, index]));
  const offset = (model: string) => {
    const index = modelIndex.get(model) ?? 0;
    return Math.max(Math.min((index - (models.length - 1) / 2) * 6, 12), -12);
  };
  const finalX = x(finalProbability);
  const finalAnchor = finalX < width * 0.15 ? "start" : finalX > width * 0.85 ? "end" : "middle";
  const toggle = (key: string) => setHighlight((current) => (current === key ? null : key));

  return (
    <figure ref={figureRef} className="chart chart--spread" onMouseLeave={() => setTooltip(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Model samples by judge">
        {TICKS.map((tick) => (
          <g key={tick}>
            <line className="chart__grid" x1={x(tick)} x2={x(tick)} y1={AXIS_HEIGHT - 6} y2={height - 6} />
            <text className="chart__axis-label" x={x(tick)} y={12} textAnchor="middle">
              {percent(tick)}
            </text>
          </g>
        ))}
        <line className="chart__final" x1={finalX} x2={finalX} y1={AXIS_HEIGHT - 6} y2={height - 6} />
        <text className="chart__annotation" x={finalX} y={AXIS_HEIGHT - 12} textAnchor={finalAnchor}>
          {`Final ${formatProbability(finalProbability)}`}
        </text>
        {rows.map((row, rowIndex) => {
          const top = AXIS_HEIGHT + rowIndex * ROW_HEIGHT;
          const centre = top + 34;
          return (
            <g key={row.judgeName}>
              <text className="chart__row-label" x={INSET} y={top + 13}>
                {row.label}
              </text>
              <line className="chart__judge-tick" x1={x(row.probability)} x2={x(row.probability)} y1={centre - 13} y2={centre + 13} />
            </g>
          );
        })}
        {marks.map(({ row, rowIndex, sample }, index) => {
          const cx = x(sample.probability);
          const cy = AXIS_HEIGHT + rowIndex * ROW_HEIGHT + 34 + offset(sample.model);
          const state = highlight === null ? "idle" : highlight === sample.model ? "active" : "dimmed";
          const show = () => {
            roving.setActive(index);
            setTooltip({
              x: (cx / width) * 100,
              y: (cy / height) * 100,
              content: (
                <>
                  <strong>{formatProbability(sample.probability)}</strong>
                  <span>
                    {sample.label}, {row.label}
                  </span>
                  <span>{humanizeToken(sample.evidenceStrength)}</span>
                  {sample.excluded ? <span>Excluded: {sample.excluded}</span> : null}
                  {sample.rationale ? <span className="chart-tooltip__quote">{excerpt(sample.rationale)}</span> : null}
                </>
              ),
            });
          };
          return (
            <g
              key={`${row.judgeName}-${sample.model}`}
              role="button"
              className="chart__point"
              data-state={state}
              aria-label={`${sample.label} for ${row.label}: ${formatProbability(sample.probability)}${
                sample.excluded ? `, excluded: ${sample.excluded}` : ""
              }`}
              {...roving.itemProps(index)}
              onClick={() => toggle(sample.model)}
              onMouseEnter={show}
              onFocus={show}
              onBlur={() => setTooltip(null)}
            >
              <circle className="chart__hit" cx={cx} cy={cy} r="12" />
              <circle className={dotClass(sample.slot, Boolean(sample.excluded))} cx={cx} cy={cy} r="4.5" />
            </g>
          );
        })}
      </svg>
      <ChartTooltip tooltip={tooltip} />
      <ul className="chart-legend" aria-label="Legend">
        {models.map((model) => (
          <li key={model.key}>
            <button
              type="button"
              className="chart-legend__toggle"
              aria-pressed={highlight === model.key}
              onClick={() => toggle(model.key)}
            >
              <span className={`chart-legend__dot chart-legend__dot--series-${model.slot}`} aria-hidden="true" />
              {model.label}
            </button>
          </li>
        ))}
        <li>
          <span className="chart-legend__tick" aria-hidden="true" />
          Judge's forecast
        </li>
        <li>
          <span className="chart-legend__swatch chart-legend__swatch--final" aria-hidden="true" />
          Final forecast
        </li>
        <li>
          <span className="chart-legend__dot chart-legend__dot--hollow" aria-hidden="true" />
          Excluded sample
        </li>
      </ul>
      <TableView caption="Model samples">
        <thead>
          <tr>
            <th scope="col">Judge</th>
            <th scope="col">Model</th>
            <th scope="col" className="data-table__number">
              Probability
            </th>
            <th scope="col">Evidence strength</th>
          </tr>
        </thead>
        <tbody>
          {marks.map(({ row, sample }) => (
            <tr key={`${row.judgeName}-${sample.model}`} className={sample.excluded ? "sample-table__row--excluded" : undefined}>
              <th scope="row">{row.label}</th>
              <td>{sample.label}</td>
              <td className="data-table__number">{formatProbability(sample.probability)}</td>
              <td>
                {humanizeToken(sample.evidenceStrength)}
                {sample.excluded ? <span className="sample-table__note">Excluded: {sample.excluded}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </TableView>
    </figure>
  );
}
