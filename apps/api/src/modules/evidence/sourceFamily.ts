import type { EvidenceItem } from "@cassandra/shared";

import type { EventRecord } from "../events/repository.js";
import { createProviderEvidenceItem, type ProviderDocument } from "./providers/fixtureLoader.js";

/** What a search was looking for. It shapes the query; it does not decide what a result is. */
export type SearchIntent = "official" | "government" | "community" | "web";

export interface SourceClassification {
  sourceFamily: Extract<EvidenceItem["sourceFamily"], "official" | "government" | "community" | "web">;
  sourceType: EvidenceItem["sourceType"];
}

const GOVERNMENT_HOST_PATTERNS = [
  /(^|\.)gov(\.[a-z]{2,3})?$/, // usa.gov, sec.gov, gov.uk, service.gov.au
  /(^|\.)mil$/,
  /(^|\.)europa\.eu$/,
  /\.int$/, // who.int, nato.int
  /(^|\.)gouv\.fr$/,
  /(^|\.)gc\.ca$/,
  /(^|\.)go\.[a-z]{2}$/, // go.jp, go.kr
  /(^|\.)gob\.[a-z]{2}$/, // gob.mx, gob.es
];

const X_HOSTS = new Set(["x.com", "twitter.com"]);
const REDDIT_HOSTS = new Set(["reddit.com", "old.reddit.com", "redd.it"]);

/** Distribution services that publish an organisation's own press releases verbatim. */
const PRESS_WIRE_HOSTS = new Set([
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "newswire.ca",
  "accesswire.com",
]);

const CORPORATE_SUFFIXES = new Set([
  "corp", "corporation", "inc", "incorporated", "ltd", "limited", "llc", "plc", "co", "company",
  "group", "holdings", "ag", "sa", "nv",
]);
const MIN_ENTITY_SLUG_LENGTH = 4;

/** "Example Corp" -> ["examplecorp", "example"]: the names an organisation's own domain may use. */
function entitySlugs(entity: string): string[] {
  const words = entity.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const withoutSuffix = words.filter((word, index) => index === 0 || !CORPORATE_SUFFIXES.has(word));

  return [...new Set([words.join(""), withoutSuffix.join("")])].filter(
    (slug) => slug.length >= MIN_ENTITY_SLUG_LENGTH,
  );
}

function isOwnDomain(host: string, entities: string[]): boolean {
  // A whole host label has to equal the name: "apple.com" is Apple's, "appleinsider.com" is not.
  const labels = new Set(host.split(".").map((label) => label.replaceAll("-", "")));

  return entities.some((entity) => entitySlugs(entity).some((slug) => labels.has(slug)));
}

/**
 * Says what kind of source a URL is, from the document itself: a government site, a
 * community post, the organisation's own site or a press wire, or the open web.
 * `entities` are the event's entities, used to recognise an organisation's own domain.
 */
export function classifySource(url: string, entities: string[]): SourceClassification {
  let host: string;

  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { sourceFamily: "web", sourceType: "web_article" };
  }

  if (GOVERNMENT_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return { sourceFamily: "government", sourceType: "government_notice" };
  }

  if (X_HOSTS.has(host)) {
    return { sourceFamily: "community", sourceType: "x_post" };
  }

  if (REDDIT_HOSTS.has(host)) {
    return { sourceFamily: "community", sourceType: "reddit_post" };
  }

  if (PRESS_WIRE_HOSTS.has(host) || isOwnDomain(host, entities)) {
    return { sourceFamily: "official", sourceType: "press_release" };
  }

  return { sourceFamily: "web", sourceType: "web_article" };
}

/** Builds evidence from a live search result, labelled by what the result is, not by which search found it. */
export function createSearchEvidenceItem(args: {
  event: Pick<EventRecord, "id" | "entities">;
  document: ProviderDocument;
  provider: string;
  queryIntent: SearchIntent;
}): EvidenceItem {
  return createProviderEvidenceItem({
    eventId: args.event.id,
    ...classifySource(args.document.url, args.event.entities),
    document: args.document,
    metadata: {
      provider: args.provider,
      queryIntent: args.queryIntent,
    },
  });
}
