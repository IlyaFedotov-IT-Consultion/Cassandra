import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EvidenceItem } from "@cassandra/shared";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultFixtureRoot = resolve(currentDir, "../../../../test/fixtures/providers");

export interface ProviderDocument {
  title?: string;
  url: string;
  publisher: string;
  publishedAt: string;
  summary: string;
  claims?: string[];
  entities?: string[];
  stance?: EvidenceItem["stance"];
  rawText?: string | null;
  metadata?: Record<string, unknown>;
  qualitySignals?: Record<string, unknown>;
}

export function slugifyEventQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function loadProviderFixture<T>(
  providerName: string,
  question: string,
  fixtureRoot = defaultFixtureRoot,
): Promise<T> {
  const fixturePath = resolve(fixtureRoot, providerName, `${slugifyEventQuestion(question)}.json`);
  const content = await readFile(fixturePath, "utf8");
  return JSON.parse(content) as T;
}

export async function fetchProviderJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`Provider request failed with ${response.status} ${response.statusText}: ${url}`);
  }

  return (await response.json()) as T;
}

export function createProviderEvidenceItem(args: {
  eventId: string;
  sourceFamily: EvidenceItem["sourceFamily"];
  sourceType: EvidenceItem["sourceType"];
  document: ProviderDocument;
  metadata?: Record<string, unknown>;
}): EvidenceItem {
  return {
    id: randomUUID(),
    eventId: args.eventId,
    sourceFamily: args.sourceFamily,
    sourceType: args.sourceType,
    title: args.document.title ?? args.document.summary ?? args.document.url,
    url: args.document.url,
    publisher: args.document.publisher,
    publishedAt: args.document.publishedAt,
    retrievedAt: new Date().toISOString(),
    summary: args.document.summary,
    rawText: args.document.rawText ?? null,
    entities: args.document.entities ?? [],
    claims: args.document.claims ?? [],
    stance: args.document.stance ?? "unknown",
    qualitySignals: args.document.qualitySignals ?? {},
    metadata: {
      ...args.metadata,
      ...args.document.metadata,
    },
  };
}
