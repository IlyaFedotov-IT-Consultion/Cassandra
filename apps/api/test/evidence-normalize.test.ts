import { describe, expect, it } from "vitest";

import type { EvidenceItem } from "@cassandra/shared";

import { canonicalizeUrl, normalizeEvidenceItems } from "../src/modules/evidence/normalize.js";

function buildEvidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    eventId: "event-1",
    sourceFamily: "web",
    sourceType: "web_article",
    title: "Example Corp Teases Product X Launch",
    url: "https://News.Example.com/product-x/?utm_source=newsletter#top",
    publisher: "  example news  ",
    publishedAt: "2026-10-10T09:00:00Z",
    retrievedAt: "2026-10-10T10:00:00Z",
    summary: "Example Corp may launch Product X later this year.",
    rawText: null,
    entities: ["Example Corp", "Product X"],
    claims: ["Product X may launch later this year", "Product X may launch later this year"],
    stance: "supports",
    qualitySignals: {},
    metadata: {},
    ...overrides,
  };
}

describe("canonicalizeUrl", () => {
  it("removes tracking params, fragments, and normalizes casing", () => {
    expect(
      canonicalizeUrl("https://News.Example.com/product-x/?utm_source=newsletter&ref=frontpage#top"),
    ).toBe("https://news.example.com/product-x?ref=frontpage");
  });
});

describe("normalizeEvidenceItems", () => {
  it("canonicalizes evidence and collapses duplicates by canonical URL and fuzzy title", () => {
    const normalized = normalizeEvidenceItems([
      buildEvidence(),
      buildEvidence({
        id: "22222222-2222-4222-8222-222222222222",
        title: "Example Corp teases Product X launch!",
        url: "https://news.example.com/product-x?utm_medium=social",
        publisher: "EXAMPLE NEWS",
        retrievedAt: "2026-10-10T11:00:00Z",
        claims: ["Launch may happen this year"],
        qualitySignals: {
          citationCount: 2,
        },
      }),
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      url: "https://news.example.com/product-x",
      publisher: "Example News",
      publishedAt: "2026-10-10T09:00:00Z",
      retrievedAt: "2026-10-10T11:00:00Z",
    });
    expect(normalized[0]?.claims).toEqual([
      "Product X may launch later this year",
      "Launch may happen this year",
    ]);
  });
});
