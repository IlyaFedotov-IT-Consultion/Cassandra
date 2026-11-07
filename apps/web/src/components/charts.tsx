import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { formatDateTime, formatProbability, formatShortDate } from "../format";

/**
 * Charts follow the workspace's dataviz rules: thin marks (2px lines, >= 8px markers
 * with a 2px surface ring), hairline solid gridlines, text in ink tokens only, series
 * colors from the validated categorical slots in fixed order, and a hover/focus tooltip
 * on every data mark.
 */

const percent = (value: number) => `${Math.round(value * 100)}%`;

interface TooltipState {
  x: number;
  y: number;
  content: ReactNode;
}

function ChartTooltip({ tooltip }: { tooltip: TooltipState | null }) {
  if (!tooltip) {
    return null;
  }

  return (
    <div className="chart-tooltip" role="tooltip" style={{ left: `${tooltip.x}%`, top: `${tooltip.y}%` }}>
      {tooltip.content}
    </div>
  );
}

/**
 * Draw at the container's real pixel width so SVG text stays at its CSS size instead of
 * scaling with the viewBox. Falls back to `fallback` where ResizeObserver is missing (jsdom).
 */
function useMeasuredWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) {
        setWidth(next);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/** Where the forecast landed on the 0-100% scale, with its band and the prior it started from. */
export function ForecastRange({
  probability,
  low,
  high,
  prior,
}: {
  probability: number;
  low: number;
  high: number;
  prior?: number | null;
}) {
  const label = `Forecast ${formatProbability(probability)}, range ${formatProbability(low)} to ${formatProbability(high)}${
    typeof prior === "number" ? `, prior ${formatProbability(prior)}` : ""
  }`;

  return (
    <figure className="forecast-range">
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label={label}>
        <rect className="forecast-range__track" x="0" y="5" width="100" height="4" rx="2" />
        {[0, 25, 50, 75, 100].map((tick) => (
          <line key={tick} className="forecast-range__tick" x1={tick} x2={tick} y1="4" y2="10" />
        ))}
        <rect
          className="forecast-range__band"
          x={low * 100}
          width={Math.max((high - low) * 100, 0.6)}
          y="3"
          height="8"
          rx="2"
        />
        {typeof prior === "number" ? (
          <line className="forecast-range__prior" x1={prior * 100} x2={prior * 100} y1="1" y2="13" />
        ) : null}
        <line className="forecast-range__final" x1={probability * 100} x2={probability * 100} y1="0" y2="14" />
      </svg>
      <div className="forecast-range__scale" aria-hidden="true">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </figure>
  );
}

export interface ForecastPoint {
  id: string;
  time: string;
  probability: number;
}

/** Final probability of each completed run over time (one series: no legend). */
export function ForecastHistoryChart({ points }: { points: ForecastPoint[] }) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [figureRef, width] = useMeasuredWidth<HTMLElement>(600);
  const sorted = [...points].sort((left, right) => left.time.localeCompare(right.time));
  const height = 200;
  const pad = { top: 14, right: 18, bottom: 26, left: 40 };
  const times = sorted.map((point) => new Date(point.time).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const x = (time: number) =>
    maxTime === minTime
      ? pad.left + (width - pad.left - pad.right) / 2
      : pad.left + ((time - minTime) / (maxTime - minTime)) * (width - pad.left - pad.right);
  const y = (probability: number) => pad.top + (1 - probability) * (height - pad.top - pad.bottom);
  const path = sorted
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(new Date(point.time).getTime())},${y(point.probability)}`)
    .join(" ");

  return (
    <figure ref={figureRef} className="chart" onMouseLeave={() => setTooltip(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Forecast history">
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line className="chart__grid" x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />
            <text className="chart__axis-label" x={pad.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {percent(tick)}
            </text>
          </g>
        ))}
        {sorted.length > 1 ? <path className="chart__line chart__line--accent" d={path} /> : null}
        {sorted.map((point) => {
          const cx = x(new Date(point.time).getTime());
          const cy = y(point.probability);
          const show = () =>
            setTooltip({
              x: (cx / width) * 100,
              y: (cy / height) * 100,
              content: (
                <>
                  <strong>{formatProbability(point.probability)}</strong>
                  <span>{formatDateTime(point.time)}</span>
                </>
              ),
            });
          return (
            <circle
              key={point.id}
              className="chart__dot chart__dot--accent"
              cx={cx}
              cy={cy}
              r="5"
              tabIndex={0}
              aria-label={`Forecast ${formatProbability(point.probability)} on ${formatDateTime(point.time)}`}
              onMouseEnter={show}
              onFocus={show}
              onBlur={() => setTooltip(null)}
            />
          );
        })}
        {sorted.length > 0 ? (
          <>
            <text className="chart__axis-label" x={x(times[0]!)} y={height - 6} textAnchor="start">
              {formatShortDate(sorted[0]!.time)}
            </text>
            {sorted.length > 1 ? (
              <text className="chart__axis-label" x={width - pad.right} y={height - 6} textAnchor="end">
                {formatShortDate(sorted[sorted.length - 1]!.time)}
              </text>
            ) : null}
          </>
        ) : null}
      </svg>
      <ChartTooltip tooltip={tooltip} />
    </figure>
  );
}

export interface ReliabilitySeries {
  key: string;
  label: string;
  /** Categorical slot (1-4), assigned by entity in a fixed order, never by rank. */
  slot: number;
  bins: Array<{ predicted: number; observed: number; count: number }>;
}

/** Predicted probability vs. observed frequency per bin; the diagonal is perfect calibration. */
export function ReliabilityChart({ series }: { series: ReliabilitySeries[] }) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const legendId = useId();
  const size = 320;
  const pad = { left: 52, right: 14, top: 14, bottom: 46 };
  const plot = size - pad.left - pad.right;
  const scale = (value: number) => pad.left + value * plot;
  const invert = (value: number) => pad.top + (1 - value) * plot;
  // Overlapping bins are common (e.g. every market resolved No). A marker covered by later
  // series grows by one ring per covering series, so the hidden point still shows its color.
  const radius = (seriesIndex: number, bin: { predicted: number; observed: number }) =>
    5 +
    4.5 *
      series
        .slice(seriesIndex + 1)
        .filter((later) =>
          later.bins.some(
            (other) => Math.abs(other.predicted - bin.predicted) < 0.02 && Math.abs(other.observed - bin.observed) < 0.02,
          ),
        ).length;

  return (
    <figure className="chart chart--square" onMouseLeave={() => setTooltip(null)}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Reliability diagram: predicted probability against observed frequency"
        aria-describedby={legendId}
      >
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line className="chart__grid" x1={scale(0)} x2={scale(1)} y1={invert(tick)} y2={invert(tick)} />
            <line className="chart__grid" x1={scale(tick)} x2={scale(tick)} y1={invert(0)} y2={invert(1)} />
            <text className="chart__axis-label" x={pad.left - 8} y={invert(tick)} textAnchor="end" dominantBaseline="middle">
              {percent(tick)}
            </text>
            <text className="chart__axis-label" x={scale(tick)} y={invert(0) + 18} textAnchor="middle">
              {percent(tick)}
            </text>
          </g>
        ))}
        <line className="chart__reference" x1={scale(0)} y1={invert(0)} x2={scale(1)} y2={invert(1)} />
        <text className="chart__axis-title" x={scale(0.5)} y={size - 6} textAnchor="middle">
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
        {series.map((entry) => {
          const bins = [...entry.bins].sort((left, right) => left.predicted - right.predicted);
          const path = bins
            .map((bin, index) => `${index === 0 ? "M" : "L"}${scale(bin.predicted)},${invert(bin.observed)}`)
            .join(" ");
          return bins.length > 1 ? (
            <path key={entry.key} className={`chart__line chart__line--series-${entry.slot}`} d={path} />
          ) : null;
        })}
        {series.map((entry, seriesIndex) => {
          const bins = [...entry.bins].sort((left, right) => left.predicted - right.predicted);
          return (
            <g key={entry.key}>
              {bins.map((bin) => {
                const cx = scale(bin.predicted);
                const cy = invert(bin.observed);
                const show = () =>
                  setTooltip({
                    x: (cx / size) * 100,
                    y: (cy / size) * 100,
                    content: (
                      <>
                        <strong>{entry.label}</strong>
                        <span>
                          Predicted {percent(bin.predicted)}, observed {percent(bin.observed)}
                        </span>
                        <span>
                          {bin.count} prediction{bin.count === 1 ? "" : "s"}
                        </span>
                      </>
                    ),
                  });
                return (
                  <circle
                    key={`${entry.key}-${bin.predicted}`}
                    className={`chart__dot chart__dot--series-${entry.slot}`}
                    cx={cx}
                    cy={cy}
                    r={radius(seriesIndex, bin)}
                    tabIndex={0}
                    aria-label={`${entry.label}: predicted ${percent(bin.predicted)}, observed ${percent(bin.observed)}, ${bin.count} prediction${bin.count === 1 ? "" : "s"}`}
                    onMouseEnter={show}
                    onFocus={show}
                    onBlur={() => setTooltip(null)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <ChartTooltip tooltip={tooltip} />
      <ul className="chart-legend" aria-label="Legend" id={legendId}>
        {series.map((entry) => (
          <li key={entry.key}>
            <span className={`chart-legend__swatch chart-legend__swatch--series-${entry.slot}`} aria-hidden="true" />
            {entry.label}
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
