import { useId, useState } from "react";

import { ChartTooltip, percent, useRovingFocus, type TooltipState } from "./primitives";

export interface ReliabilitySeries {
  key: string;
  label: string;
  /** Categorical slot (1-4), assigned by entity in a fixed order, never by rank. */
  slot: number;
  bins: Array<{ predicted: number; observed: number; count: number }>;
}

const SIZE = 320;
const PAD = { left: 52, right: 14, top: 14, bottom: 46 };
const PLOT = SIZE - PAD.left - PAD.right;
const scale = (value: number) => PAD.left + value * PLOT;
const invert = (value: number) => PAD.top + (1 - value) * PLOT;

/**
 * Predicted probability vs. observed frequency per bin; the diagonal is perfect
 * calibration. Legend entries switch a baseline off and on; the others keep their colour.
 */
export function ReliabilityChart({ series }: { series: ReliabilitySeries[] }) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const legendId = useId();
  const shown = series.filter((entry) => !hidden.has(entry.key));
  const marks = shown.flatMap((entry, seriesIndex) =>
    [...entry.bins]
      .sort((left, right) => left.predicted - right.predicted)
      .map((bin) => ({ entry, seriesIndex, bin })),
  );
  const roving = useRovingFocus<SVGGElement>(marks.length);

  // Overlapping bins are common (e.g. every market resolved No). A marker covered by later
  // series grows by one ring per covering series, so the hidden point still shows its colour.
  const radius = (seriesIndex: number, bin: { predicted: number; observed: number }) =>
    5 +
    4.5 *
      shown
        .slice(seriesIndex + 1)
        .filter((later) =>
          later.bins.some(
            (other) => Math.abs(other.predicted - bin.predicted) < 0.02 && Math.abs(other.observed - bin.observed) < 0.02,
          ),
        ).length;

  const toggle = (key: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  return (
    <figure className="chart chart--square" onMouseLeave={() => setTooltip(null)}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="group"
        aria-label="Reliability diagram: predicted probability against observed frequency"
        aria-describedby={legendId}
      >
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line className="chart__grid" x1={scale(0)} x2={scale(1)} y1={invert(tick)} y2={invert(tick)} />
            <line className="chart__grid" x1={scale(tick)} x2={scale(tick)} y1={invert(0)} y2={invert(1)} />
            <text className="chart__axis-label" x={PAD.left - 8} y={invert(tick)} textAnchor="end" dominantBaseline="middle">
              {percent(tick)}
            </text>
            <text className="chart__axis-label" x={scale(tick)} y={invert(0) + 18} textAnchor="middle">
              {percent(tick)}
            </text>
          </g>
        ))}
        <line className="chart__reference" x1={scale(0)} y1={invert(0)} x2={scale(1)} y2={invert(1)} />
        <text className="chart__axis-title" x={scale(0.5)} y={SIZE - 6} textAnchor="middle">
          Predicted
        </text>
        <text
          className="chart__axis-title"
          x={12}
          y={invert(0.5)}
          textAnchor="middle"
          transform={`rotate(-90 12 ${invert(0.5)})`}
        >
          Observed
        </text>
        {shown.map((entry) => {
          const bins = [...entry.bins].sort((left, right) => left.predicted - right.predicted);
          const path = bins
            .map((bin, index) => `${index === 0 ? "M" : "L"}${scale(bin.predicted)},${invert(bin.observed)}`)
            .join(" ");
          return bins.length > 1 ? (
            <path key={entry.key} className={`chart__line chart__line--series-${entry.slot}`} d={path} />
          ) : null;
        })}
        {marks.map(({ entry, seriesIndex, bin }, index) => {
          const cx = scale(bin.predicted);
          const cy = invert(bin.observed);
          const predictions = `${bin.count} prediction${bin.count === 1 ? "" : "s"}`;
          const show = () => {
            roving.setActive(index);
            setTooltip({
              x: (cx / SIZE) * 100,
              y: (cy / SIZE) * 100,
              content: (
                <>
                  <strong>
                    Observed {percent(bin.observed)} at predicted {percent(bin.predicted)}
                  </strong>
                  <span>{entry.label}</span>
                  <span>{predictions}</span>
                </>
              ),
            });
          };
          return (
            <g
              key={`${entry.key}-${bin.predicted}`}
              role="img"
              className="chart__point"
              data-slot={entry.slot}
              aria-label={`${entry.label}: predicted ${percent(bin.predicted)}, observed ${percent(bin.observed)}, ${predictions}`}
              {...roving.itemProps(index)}
              onMouseEnter={show}
              onFocus={show}
              onBlur={() => setTooltip(null)}
            >
              <circle className="chart__hit" cx={cx} cy={cy} r="12" />
              <circle className={`chart__dot chart__dot--series-${entry.slot}`} cx={cx} cy={cy} r={radius(seriesIndex, bin)} />
            </g>
          );
        })}
      </svg>
      <ChartTooltip tooltip={tooltip} />
      <ul className="chart-legend" aria-label="Legend" id={legendId}>
        {series.map((entry) => (
          <li key={entry.key}>
            <button
              type="button"
              className="chart-legend__toggle chart-legend__toggle--visibility"
              aria-pressed={!hidden.has(entry.key)}
              onClick={() => toggle(entry.key)}
            >
              <span className={`chart-legend__swatch chart-legend__swatch--series-${entry.slot}`} aria-hidden="true" />
              {entry.label}
            </button>
          </li>
        ))}
        <li>
          <span className="chart-legend__swatch chart-legend__swatch--reference" aria-hidden="true" />
          Perfect calibration
        </li>
      </ul>
    </figure>
  );
}
