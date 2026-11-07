import { afterEach, describe, expect, it, vi } from "vitest";

import { getEnv } from "../src/config/env.js";
import type { EventRecord } from "../src/modules/events/repository.js";
import {
  assertLiveAuthoritativeSearchProviderConfigured,
  createDefaultEvidenceProviders,
} from "../src/modules/judgments/service.js";

const event: EventRecord = {
  id: "event-search",
  question: "Will US CPI inflation exceed 3% in October 2026?",
  resolutionCriteria: "BLS CPI release.",
  deadline: "2026-11-30T23:59:59Z",
  status: "active",
  entities: ["Bureau of Labor Statistics"],
  referenceClass: null,
  marketSymbols: [],
  polymarketMarketId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function liveEnv(overrides: Record<string, string>) {
  return getEnv({
    CASSANDRA_ADAPTER_MODE: "live",
    LOG_LEVEL: "silent",
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("search backend selection", () => {
  it("routes live official, government, community and web search through OpenRouter when selected", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify({ choices: [{ message: { annotations: [] } }] }), { status: 200 });
      }),
    );
    const env = liveEnv({
      CASSANDRA_SEARCH_BACKEND: "openrouter",
      OPENROUTER_API_KEY: "or-key",
      ZAI_API_KEY: "zai-key",
    });
    const searchProviders = createDefaultEvidenceProviders(env).filter((provider) =>
      ["officialSearch", "governmentSearch", "communitySearch", "web"].includes(provider.name),
    );

    for (const provider of searchProviders) {
      await provider.collect({ event, evaluationTime: "2026-11-07T00:00:00Z", mode: "live" });
    }

    expect(searchProviders).toHaveLength(4);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.url.startsWith("https://openrouter.ai/"))).toBe(true);
    const domainsByQuery = requests.map(
      (request) => (request.body.plugins as Array<{ include_domains?: string[] }>)[0]?.include_domains,
    );
    expect(domainsByQuery).toContainEqual(expect.arrayContaining(["*.gov"]));
    expect(domainsByQuery).toContainEqual(["reddit.com", "x.com"]);
  });

  it("accepts OpenRouter as the authoritative search provider for live judgments", () => {
    expect(() =>
      assertLiveAuthoritativeSearchProviderConfigured(liveEnv({ OPENROUTER_API_KEY: "or-key" })),
    ).not.toThrow();
  });

  it("prefers Z.AI in auto mode when its key is configured", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        requested.push(String(input));
        return new Response(JSON.stringify({ search_result: [] }), { status: 200 });
      }),
    );
    const official = createDefaultEvidenceProviders(
      liveEnv({ OPENROUTER_API_KEY: "or-key", ZAI_API_KEY: "zai-key" }),
    ).find((provider) => provider.name === "officialSearch");

    await official?.collect({ event, evaluationTime: "2026-11-07T00:00:00Z", mode: "live" });

    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("api.z.ai");
  });
});

describe("Z.AI search dating", () => {
  it("marks results without a publish date as undated instead of dating them now", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            search_result: [
              { title: "Dated", link: "https://example.com/dated", content: "x", publish_date: "2026-10-01" },
              { title: "Undated", link: "https://example.com/undated", content: "y" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const { searchWithZaiCli } = await import("../src/modules/evidence/providers/zaiCli.js");

    const documents = await searchWithZaiCli({ apiKey: "zai-key", providerName: "web", query: "q" });

    expect(documents.map((document) => document.metadata?.publishedAtSource)).toEqual(["provider", "unknown"]);
  });
});

describe("planned sub-question queries", () => {
  it("runs the provider's own query plus up to two planned queries and deduplicates results", async () => {
    const { createWebProvider } = await import("../src/modules/evidence/providers/web.js");
    const queries: string[] = [];
    const provider = createWebProvider({
      search: async (request) => {
        queries.push(request.query);
        return [
          { title: "Shared", url: "https://example.com/shared", publisher: "x", publishedAt: "2026-11-01T00:00:00.000Z", summary: "s" },
          { title: request.query, url: `https://example.com/${queries.length}`, publisher: "x", publishedAt: "2026-11-01T00:00:00.000Z", summary: "s" },
        ];
      },
    });

    const items = await provider.collect({
      event,
      evaluationTime: "2026-11-07T00:00:00Z",
      mode: "live",
      queries: ["CPI October 2026 consensus forecast", "BLS CPI release schedule", "ignored third query"],
    });

    expect(queries).toHaveLength(3);
    expect(queries.slice(1)).toEqual(["CPI October 2026 consensus forecast", "BLS CPI release schedule"]);
    expect(items.filter((item) => item.url === "https://example.com/shared")).toHaveLength(1);
    expect(items).toHaveLength(4);
  });

  it("keeps the provider working when a planned query fails", async () => {
    const { createOfficialSearchProvider } = await import("../src/modules/evidence/providers/officialSearch.js");
    let call = 0;
    const provider = createOfficialSearchProvider({
      search: async () => {
        call += 1;
        if (call > 1) {
          throw new Error("planned query timed out");
        }
        return [{ title: "Base", url: "https://example.com/base", publisher: "x", publishedAt: "2026-11-01T00:00:00.000Z", summary: "s" }];
      },
    });

    const items = await provider.collect({
      event,
      evaluationTime: "2026-11-07T00:00:00Z",
      mode: "live",
      queries: ["planned query"],
    });

    expect(items.map((item) => item.url)).toEqual(["https://example.com/base"]);
  });
});

describe("query planning seam", () => {
  it("asks the judge service to plan queries and records the stage", async () => {
    const { planEventQueries } = await import("../src/modules/judgments/service.js");
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ subQuestions: ["Is a release scheduled?"], queries: ["BLS CPI release schedule"], model: "utility" }),
          { status: 200 },
        );
      }),
    );

    const result = await planEventQueries({
      env: liveEnv({ JUDGE_BASE_URL: "http://judge.local", OPENROUTER_API_KEY: "or-key" }),
      event,
      evaluationTime: "2026-11-07T00:00:00Z",
    });

    expect(requests[0]?.url).toBe("http://judge.local/plan");
    expect(requests[0]?.body).toMatchObject({ evaluationTime: "2026-11-07T00:00:00Z", maxQueries: 3 });
    expect(result.queries).toEqual(["BLS CPI release schedule"]);
    expect(result.stage).toMatchObject({
      stage: "query_planning",
      status: "completed",
      details: { queries: ["BLS CPI release schedule"], subQuestions: ["Is a release scheduled?"] },
    });
  });

  it("treats a planning failure as non-fatal", async () => {
    const { planEventQueries } = await import("../src/modules/judgments/service.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));

    const result = await planEventQueries({
      env: liveEnv({ JUDGE_BASE_URL: "http://judge.local", OPENROUTER_API_KEY: "or-key" }),
      event,
      evaluationTime: "2026-11-07T00:00:00Z",
    });

    expect(result.queries).toEqual([]);
    expect(result.stage.status).toBe("failed");
  });
});
