import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * Shared pieces of the workspace's charts. The rules they follow: thin marks (2px lines,
 * >= 8px markers with a 2px plate ring), hairline solid gridlines, text in ink tokens
 * only, categorical colours by entity in a fixed order, the signal colour only for
 * forecast probabilities, a hover/focus readout on every mark, and a table view.
 */

export const percent = (value: number) => `${Math.round(value * 100)}%`;

const EPSILON = 1e-6;

/** Log-odds of a probability, clamped so 0% and 100% stay finite. */
export function logit(probability: number) {
  const clamped = Math.min(Math.max(probability, EPSILON), 1 - EPSILON);
  return Math.log(clamped / (1 - clamped));
}

export function sigmoid(logOdds: number) {
  return 1 / (1 + Math.exp(-logOdds));
}

export interface TooltipState {
  /** Anchor, as a percentage of the figure's width and height. */
  x: number;
  y: number;
  content: ReactNode;
}

/** A floating readout above a mark; flips inwards near the figure's edges. */
export function ChartTooltip({ tooltip }: { tooltip: TooltipState | null }) {
  if (!tooltip) {
    return null;
  }

  const edge = tooltip.x < 22 ? " chart-tooltip--start" : tooltip.x > 78 ? " chart-tooltip--end" : "";
  return (
    <div className={`chart-tooltip${edge}`} role="tooltip" style={{ left: `${tooltip.x}%`, top: `${tooltip.y}%` }}>
      {tooltip.content}
    </div>
  );
}

/**
 * Draw at the container's real pixel width so SVG text stays at its CSS size instead of
 * scaling with the viewBox. Falls back to `fallback` where ResizeObserver is missing (jsdom).
 */
export function useMeasuredWidth<T extends Element>(fallback: number) {
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

/**
 * One tab stop for a set of marks: arrow keys, Home and End move focus between them
 * (a roving tabindex), so a chart with many marks does not trap keyboard users.
 */
export function useRovingFocus<T extends Element & { focus(): void }>(count: number) {
  const [active, setActive] = useState(0);
  const items = useRef<Array<T | null>>([]);

  const moveTo = useCallback(
    (index: number) => {
      if (count === 0) {
        return;
      }
      const next = (index + count) % count;
      setActive(next);
      items.current[next]?.focus();
    },
    [count],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent, index: number) => {
      const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (event.key in step) {
        event.preventDefault();
        moveTo(index + step[event.key]!);
      } else if (event.key === "Home") {
        event.preventDefault();
        moveTo(0);
      } else if (event.key === "End") {
        event.preventDefault();
        moveTo(count - 1);
      }
    },
    [count, moveTo],
  );

  const itemProps = (index: number) => ({
    ref: (node: T | null) => {
      items.current[index] = node;
    },
    tabIndex: index === Math.min(active, count - 1) ? 0 : -1,
    onKeyDown: (event: KeyboardEvent) => onKeyDown(event, index),
  });

  return { active, setActive, itemProps };
}

/** Every chart's values, reachable without hovering. */
export function TableView({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <details className="disclosure chart-table">
      <summary>Show as table</summary>
      <div className="table-shell">
        <table className="data-table">
          <caption>{caption}</caption>
          {children}
        </table>
      </div>
    </details>
  );
}

/** A two-or-more option switch rendered as pressed buttons. */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__option"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
