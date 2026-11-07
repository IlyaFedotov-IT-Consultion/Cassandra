const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
  timeZoneName: "short",
});

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "Nov 7" (UTC), for chart axes where the full timestamp would collide. */
export function formatShortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : shortDateFormatter.format(date);
}

/** "0xd4e77ba6…a318527": keeps both ends of a long identifier recognisable. */
export function shortenIdentifier(value: string, keep = 8) {
  return value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value;
}

/** Evidence provider ids are camelCase (`polymarketGamma`); show them as words. */
export function humanizeProviderName(value: string) {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

export function humanizeToken(value: string) {
  const normalizedValue = value.trim().replaceAll("_", " ");

  if (!normalizedValue) {
    return value;
  }

  return normalizedValue.charAt(0).toUpperCase() + normalizedValue.slice(1);
}

export function formatDateTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return dateTimeFormatter.format(date);
}

export function formatProbability(value?: number | null) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "Pending";
}

export function formatDecimal(value: number) {
  return value.toFixed(2);
}

export function formatSignedDecimal(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}
