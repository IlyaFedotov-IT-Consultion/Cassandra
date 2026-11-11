import type { EvidenceItem } from "@cassandra/shared";

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
]);

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function parseTime(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function mergeUniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of values.map(normalizeWhitespace).filter(Boolean)) {
    const key = value.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      merged.push(value);
    }
  }

  return merged;
}

function mergeStringRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  duplicateClusterSize: number,
): Record<string, unknown> {
  return {
    ...left,
    ...right,
    duplicateClusterSize,
  };
}

function fuzzyTitleKey(title: string): string {
  return normalizeWhitespace(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mergeEvidenceItems(left: EvidenceItem, right: EvidenceItem): EvidenceItem {
  const leftPublishedAt = parseTime(left.publishedAt);
  const rightPublishedAt = parseTime(right.publishedAt);
  const leftRetrievedAt = parseTime(left.retrievedAt);
  const rightRetrievedAt = parseTime(right.retrievedAt);
  const duplicateClusterSize =
    Number(left.qualitySignals.duplicateClusterSize ?? 1) +
    Number(right.qualitySignals.duplicateClusterSize ?? 1);

  return {
    ...left,
    title: left.title.length >= right.title.length ? left.title : right.title,
    url: left.url,
    publisher: left.publisher,
    publishedAt: leftPublishedAt <= rightPublishedAt ? left.publishedAt : right.publishedAt,
    retrievedAt: leftRetrievedAt >= rightRetrievedAt ? left.retrievedAt : right.retrievedAt,
    summary: left.summary.length >= right.summary.length ? left.summary : right.summary,
    rawText:
      (left.rawText?.length ?? 0) >= (right.rawText?.length ?? 0) ? left.rawText : right.rawText,
    entities: mergeUniqueValues([...left.entities, ...right.entities]),
    claims: mergeUniqueValues([...left.claims, ...right.claims]),
    qualitySignals: mergeStringRecords(left.qualitySignals, right.qualitySignals, duplicateClusterSize),
    metadata: {
      ...left.metadata,
      ...right.metadata,
    },
  };
}

export function canonicalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";

  const retainedEntries = [...parsed.searchParams.entries()].filter(
    ([key]) => !TRACKING_QUERY_KEYS.has(key.toLowerCase()),
  );

  parsed.search = "";

  for (const [key, value] of retainedEntries) {
    parsed.searchParams.append(key, value);
  }

  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  return parsed.toString();
}

export function normalizeEvidenceItem(item: EvidenceItem): EvidenceItem {
  return {
    ...item,
    title: normalizeWhitespace(item.title),
    url: canonicalizeUrl(item.url),
    publisher: titleCase(normalizeWhitespace(item.publisher)),
    summary: normalizeWhitespace(item.summary),
    rawText: item.rawText ? normalizeWhitespace(item.rawText) : null,
    entities: mergeUniqueValues(item.entities),
    claims: mergeUniqueValues(item.claims),
    qualitySignals: {
      duplicateClusterSize: Number(item.qualitySignals.duplicateClusterSize ?? 1),
      ...item.qualitySignals,
    },
  };
}

export function normalizeEvidenceItems(items: EvidenceItem[]): EvidenceItem[] {
  const mergedByUrl = new Map<string, EvidenceItem>();
  const urlKeysByTitle = new Map<string, string>();

  for (const item of items.map(normalizeEvidenceItem)) {
    // Same title in the same source family is the same story republished. Across families
    // it is not: a community post about an article is different evidence from the article.
    const titleKey = `${item.sourceFamily}|${fuzzyTitleKey(item.title)}`;
    const urlKey = item.url;
    const existingUrlKey = mergedByUrl.has(urlKey) ? urlKey : urlKeysByTitle.get(titleKey);

    if (!existingUrlKey) {
      mergedByUrl.set(urlKey, item);
      urlKeysByTitle.set(titleKey, urlKey);
      continue;
    }

    const existing = mergedByUrl.get(existingUrlKey);

    if (!existing) {
      mergedByUrl.set(urlKey, item);
      urlKeysByTitle.set(titleKey, urlKey);
      continue;
    }

    const merged = mergeEvidenceItems(existing, item);
    mergedByUrl.set(existingUrlKey, merged);
    urlKeysByTitle.set(titleKey, existingUrlKey);
  }

  return [...mergedByUrl.values()];
}
