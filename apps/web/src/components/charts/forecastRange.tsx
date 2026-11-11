import { formatProbability } from "../../format";

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
