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
