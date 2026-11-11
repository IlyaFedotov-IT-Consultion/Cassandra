import { createHash, timingSafeEqual } from "node:crypto";

import type { IncomingHttpHeaders } from "node:http";

function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

/** Parses a comma-separated origin allowlist into a matcher. */
export function createOriginAllowlist(configured: string): (origin: string) => boolean {
  const allowed = new Set(configured.split(",").map(normalizeOrigin).filter(Boolean));

  return (origin) => allowed.has(normalizeOrigin(origin));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** True when the request carries the API key as `x-api-key` or as a bearer token. */
export function hasValidApiKey(headers: IncomingHttpHeaders, apiKey: string): boolean {
  const headerKey = headers["x-api-key"];
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? "")?.[1];
  const presented = (Array.isArray(headerKey) ? headerKey[0] : headerKey) ?? bearer;

  // Comparing digests keeps the comparison constant-time whatever the lengths are.
  return typeof presented === "string" && timingSafeEqual(digest(presented), digest(apiKey));
}
