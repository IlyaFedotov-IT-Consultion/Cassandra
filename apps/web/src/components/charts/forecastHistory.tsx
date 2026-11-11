import { useId, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

import { formatDateTime, formatProbability, formatShortDate } from "../../format";
import { ChartTooltip, percent, useMeasuredWidth } from "./primitives";

export interface ForecastPoint {
  id: string;
  time: string;
  probability: number;
  low?: number;
  high?: number;
}

export interface ResolvedOutcome {
  resolvedValue: boolean;
  resolvedAt: string;
}

const HEIGHT = 220;
const PAD = { top: 18, right: 18, bottom: 28, left: 42 };
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

function rangeText(point: ForecastPoint) {
  return typeof point.low === "number" && typeof point.high === "number"
    ? `Range ${formatProbability(point.low)}–${formatProbability(point.high)}`
    : null;
}

/**
 * Final probability of each completed run over time, with its uncertainty band. One
 * series, so no legend. The crosshair snaps to the nearest run; arrow keys step through
 * runs and Enter (or a click) opens one.
 */
export function ForecastHistoryChart({
  points,
  outcome = null,
  onSelect,
}: {
  points: ForecastPoint[];
  outcome?: ResolvedOutcome | null;
  onSelect?: (id: string) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [figureRef, width] = useMeasuredWidth<HTMLElement>(600);
  const hintId = useId();
  const sorted = [...points].sort((left, right) => left.time.localeCompare(right.time));
  const times = sorted.map((point) => new Date(point.time).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const plotWidth = width - PAD.left - PAD.right;
  const x = (time: number) =>
    maxTime === minTime ? PAD.left + plotWidth / 2 : PAD.left + ((time - minTime) / (maxTime - minTime)) * plotWidth;
  const y = (probability: number) => PAD.top + (1 - probability) * (HEIGHT - PAD.top - PAD.bottom);
  const line = sorted.map((point, index) => `${index === 0 ? "M" : "L"}${x(times[index]!)},${y(point.probability)}`).join(" ");
  const banded = sorted.every((point) => typeof point.low === "number" && typeof point.high === "number");
  const band = banded
    ? [
        ...sorted.map((point, index) => `${index === 0 ? "M" : "L"}${x(times[index]!)},${y(point.high!)}`),
        ...[...sorted].reverse().map((point, index) => `L${x(times[sorted.length - 1 - index]!)},${y(point.low!)}`),
        "Z",
      ].join(" ")
    : null;
  const activePoint = active === null ? null : sorted[active] ?? null;

  const nearestTo = (clientX: number, element: Element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || sorted.length === 0) {
      return null;
    }
    const svgX = ((clientX - rect.left) / rect.width) * width;
    let best = 0;
    for (let index = 1; index < sorted.length; index += 1) {
      if (Math.abs(x(times[index]!) - svgX) < Math.abs(x(times[best]!) - svgX)) {
        best = index;
      }
    }
    return best;
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const index = nearestTo(event.clientX, event.currentTarget);
    if (index !== null) {
      setActive(index);
    }
  };

  const onPlotClick = (event: MouseEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest("[data-point]") || active === null) {
      return;
    }
    onSelect?.(sorted[active]!.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = sorted.length - 1;
    const current = active ?? last;
    const next: Record<string, number> = {
      ArrowLeft: Math.max(current - 1, 0),
      ArrowDown: Math.max(current - 1, 0),
      ArrowRight: Math.min(current + 1, last),
      ArrowUp: Math.min(current + 1, last),
      Home: 0,
      End: last,
    };
    if (event.key in next) {
      event.preventDefault();
      setActive(next[event.key]!);
    } else if ((event.key === "Enter" || event.key === " ") && onSelect && sorted[current]) {
      event.preventDefault();
      onSelect(sorted[current]!.id);
    }
  };

  return (
    <figure ref={figureRef} className="chart chart--history">
      <div
        className="chart__focus-frame"
        role="group"
        aria-label="Forecast history"
        aria-describedby={onSelect ? hintId : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((current) => current ?? sorted.length - 1)}
        onBlur={() => setActive(null)}
      >
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          onClick={onPlotClick}
          className={onSelect ? "chart__plot chart__plot--selectable" : "chart__plot"}
        >
          {Y_TICKS.map((tick) => (
            <g key={tick}>
              <line className="chart__grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="chart__axis-label" x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                {percent(tick)}
              </text>
            </g>
          ))}
          {band ? <path className="chart__band" d={band} /> : null}
          {outcome ? (
            <g className="chart__outcome">
              <line x1={PAD.left} x2={width - PAD.right} y1={y(outcome.resolvedValue ? 1 : 0)} y2={y(outcome.resolvedValue ? 1 : 0)} />
              <text
                className="chart__annotation"
                x={width - PAD.right}
                y={y(outcome.resolvedValue ? 1 : 0) - 6}
                textAnchor="end"
              >
                {outcome.resolvedValue ? "Resolved Yes" : "Resolved No"}
              </text>
            </g>
          ) : null}
          {activePoint ? (
            <line
              className="chart__crosshair"
              x1={x(times[active!]!)}
              x2={x(times[active!]!)}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
            />
          ) : null}
          {sorted.length > 1 ? <path className="chart__line chart__line--accent" d={line} /> : null}
          {sorted.map((point, index) => {
            const range = rangeText(point);
            return (
              <g
                key={point.id}
                data-point
                role="button"
                tabIndex={-1}
                className="chart__point"
                data-state={index === active ? "active" : "idle"}
                aria-label={`Forecast ${formatProbability(point.probability)} on ${formatDateTime(point.time)}${range ? `, ${range.toLowerCase()}` : ""}`}
                onPointerEnter={() => setActive(index)}
                onClick={() => onSelect?.(point.id)}
              >
                <circle className="chart__hit" cx={x(times[index]!)} cy={y(point.probability)} r="12" />
                <circle
                  className="chart__dot chart__dot--accent"
                  cx={x(times[index]!)}
                  cy={y(point.probability)}
                  r={index === active ? 6 : 4.5}
                />
              </g>
            );
          })}
          {sorted.length > 0 ? (
            <>
              <text className="chart__axis-label" x={x(times[0]!)} y={HEIGHT - 6} textAnchor="start">
                {formatShortDate(sorted[0]!.time)}
              </text>
              {sorted.length > 1 ? (
                <text className="chart__axis-label" x={width - PAD.right} y={HEIGHT - 6} textAnchor="end">
                  {formatShortDate(sorted[sorted.length - 1]!.time)}
                </text>
              ) : null}
            </>
          ) : null}
        </svg>
      </div>
      {onSelect ? (
        <p id={hintId} className="chart__hint">
          Arrow keys step through runs; Enter or a click opens one.
        </p>
      ) : null}
      <ChartTooltip
        tooltip={
          activePoint
            ? {
                x: (x(times[active!]!) / width) * 100,
                y: (y(activePoint.probability) / HEIGHT) * 100,
                content: (
                  <>
                    <strong>{formatProbability(activePoint.probability)}</strong>
                    {rangeText(activePoint) ? <span>{rangeText(activePoint)}</span> : null}
                    <span>{formatDateTime(activePoint.time)}</span>
                  </>
                ),
              }
            : null
        }
      />
    </figure>
  );
}
