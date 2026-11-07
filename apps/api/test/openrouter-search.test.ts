import { afterEach, describe, expect, it, vi } from "vitest";

import { searchWithOpenRouter } from "../src/modules/evidence/providers/openRouterSearch.js";

function annotation(url: string, title: string, content: string) {
  return { type: "url_citation", url_citation: { url, title, content, start_index: 0, end_index: 0 } };
}

function stubOpenRouter(annotations: unknown[], status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        status === 200
          ? JSON.stringify({ choices: [{ message: { content: "ok", annotations } }] })
          : JSON.stringify({ error: { message: "rate limited" } }),
        { status },
      );
    }),
  );
  return calls;
}

const baseArgs = {
  apiKey: "test-key",
  providerName: "web",
  query: "Federal Reserve rate decision October 2026",
  retrievedAt: "2026-11-07T12:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter web search", () => {
  it("asks the web plugin for the configured engine, result count and domains", async () => {
    const calls = stubOpenRouter([]);

    await searchWithOpenRouter({
      ...baseArgs,
      count: 4,
      domains: ["*.gov", "europa.eu"],
      engine: "perplexity",
      model: "openai/gpt-4o-mini",
    });

    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.headers.Authorization).toBe("Bearer test-key");
    expect(calls[0]?.body).toMatchObject({
      model: "openai/gpt-4o-mini",
      plugins: [{ id: "web", engine: "perplexity", max_results: 4, include_domains: ["*.gov", "europa.eu"] }],
    });
  });

  it("maps retrieved sources to documents, deduplicating URLs", async () => {
    stubOpenRouter([
      annotation("https://www.cnbc.com/2026/10/28/fed-holds.html", "Fed holds rates", "The Fed held rates steady."),
      annotation("https://www.cnbc.com/2026/10/28/fed-holds.html", "Fed holds rates (dup)", "Duplicate."),
    ]);

    const documents = await searchWithOpenRouter(baseArgs);

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      title: "Fed holds rates",
      url: "https://www.cnbc.com/2026/10/28/fed-holds.html",
      publisher: "www.cnbc.com",
      summary: "The Fed held rates steady.",
      metadata: { provider: "web", searchBackend: "openrouter" },
    });
  });

  it("dates sources from their URL first, then from the opening text, never in the future", async () => {
    stubOpenRouter([
      annotation("https://www.cnbc.com/2026/10/28/fed-holds.html", "From URL", "Body."),
      annotation("https://www.federalreserve.gov/press/monetary20261028a.htm", "Compact URL date", "Body."),
      annotation(
        "https://example.com/analysis",
        "From content",
        "Published October 27, 2026. The committee will meet again on December 16, 2026.",
      ),
      annotation("https://example.com/undated", "Undated", "No dates here."),
    ]);

    const documents = await searchWithOpenRouter(baseArgs);
    const byTitle = Object.fromEntries(documents.map((document) => [document.title, document]));

    expect(byTitle["From URL"]).toMatchObject({
      publishedAt: "2026-10-28T00:00:00.000Z",
      metadata: { publishedAtSource: "url" },
    });
    expect(byTitle["Compact URL date"]?.publishedAt).toBe("2026-10-28T00:00:00.000Z");
    expect(byTitle["From content"]).toMatchObject({
      publishedAt: "2026-10-27T00:00:00.000Z",
      metadata: { publishedAtSource: "content" },
    });
    expect(byTitle.Undated).toMatchObject({
      publishedAt: baseArgs.retrievedAt,
      metadata: { publishedAtSource: "unknown" },
    });
  });

  it("reports OpenRouter failures with their status", async () => {
    stubOpenRouter([], 429);

    await expect(searchWithOpenRouter(baseArgs)).rejects.toThrow(/429/);
  });
});
