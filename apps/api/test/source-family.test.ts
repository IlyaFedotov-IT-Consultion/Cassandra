import { describe, expect, it } from "vitest";

import { createCommunitySearchProvider } from "../src/modules/evidence/providers/communitySearch.js";
import type { ProviderDocument } from "../src/modules/evidence/providers/fixtureLoader.js";
import { createOfficialSearchProvider } from "../src/modules/evidence/providers/officialSearch.js";
import { createWebProvider } from "../src/modules/evidence/providers/web.js";
import { classifySource } from "../src/modules/evidence/sourceFamily.js";
import type { EventRecord } from "../src/modules/events/repository.js";

describe("classifySource", () => {
  it.each([
    ["https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm", ["Federal Reserve"], "government"],
    ["https://www.gov.uk/government/news/budget", [], "government"],
    ["https://ec.europa.eu/commission/presscorner/detail/en/ip_26_1", [], "government"],
    ["https://www.who.int/news/item/01-10-2026-statement", [], "government"],
    ["https://www.reddit.com/r/stocks/comments/abc/thread", [], "community"],
    ["https://x.com/someone/status/1", ["Example Corp"], "community"],
    ["https://investor.examplecorp.com/news/2026/product-x", ["Example Corp"], "official"],
    ["https://www.example.com/press/product-x", ["Example Corp"], "official"],
    ["https://www.prnewswire.com/news-releases/example-corp-launches-product-x.html", [], "official"],
    ["https://appleinsider.com/articles/26/10/01/rumour", ["Apple"], "web"],
    ["https://www.cnbc.com/2026/10/28/fed-holds-rates.html", ["Federal Reserve"], "web"],
    ["https://www.govtech.com/policy/story", [], "web"],
    ["not a url", ["Example Corp"], "web"],
  ])("%s is %s evidence", (url, entities, family) => {
    expect(classifySource(url, entities as string[]).sourceFamily).toBe(family);
  });

  it("names the source type that goes with the family", () => {
    expect(classifySource("https://x.com/someone/status/1", []).sourceType).toBe("x_post");
    expect(classifySource("https://www.reddit.com/r/stocks/1", []).sourceType).toBe("reddit_post");
    expect(classifySource("https://www.sec.gov/ix?doc=1", []).sourceType).toBe("government_notice");
    expect(classifySource("https://www.businesswire.com/news/1", []).sourceType).toBe("press_release");
    expect(classifySource("https://www.cnbc.com/story", []).sourceType).toBe("web_article");
  });
});

const event: EventRecord = {
  id: "event-family",
  question: "Will Example Corp launch Product X by 2026-12-31?",
  resolutionCriteria: "Official launch announcement.",
  deadline: "2026-12-31T23:59:59Z",
  status: "active",
  entities: ["Example Corp", "Product X"],
  referenceClass: null,
  marketSymbols: [],
  polymarketMarketId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function document(url: string): ProviderDocument {
  return { title: `Story at ${url}`, url, publisher: new URL(url).hostname, publishedAt: "2026-11-01T00:00:00Z", summary: "s" };
}

async function collectLive(
  createProvider: (config: { search: () => Promise<ProviderDocument[]> }) => { collect: Function },
  urls: string[],
) {
  const provider = createProvider({ search: async () => urls.map(document) });
  const items = await provider.collect({ event, evaluationTime: "2026-11-07T00:00:00Z", mode: "live" });
  return items as Array<{ url: string; sourceFamily: string; sourceType: string; metadata: Record<string, unknown> }>;
}

describe("source family of live search results", () => {
  it("labels what the official-source search found by where it was published, not by the query", async () => {
    const items = await collectLive(createOfficialSearchProvider, [
      "https://www.cnbc.com/2026/10/28/example-corp-product-x.html",
      "https://investor.examplecorp.com/news/product-x",
      "https://www.sec.gov/Archives/edgar/data/1/8k.htm",
    ]);

    expect(items.map((item) => item.sourceFamily)).toEqual(["web", "official", "government"]);
    expect(items.map((item) => item.sourceType)).toEqual(["web_article", "press_release", "government_notice"]);
    expect(items[0]?.metadata).toMatchObject({ provider: "officialSearch", queryIntent: "official" });
  });

  it("recognises a government or official page that the general web search found", async () => {
    const items = await collectLive(createWebProvider, [
      "https://www.ftc.gov/news-events/news/press-releases/2026/10/statement",
      "https://www.example.com/newsroom/product-x",
      "https://www.theverge.com/2026/10/1/product-x",
    ]);

    expect(items.map((item) => item.sourceFamily)).toEqual(["government", "official", "web"]);
  });

  it("keeps community results as community posts", async () => {
    const items = await collectLive(createCommunitySearchProvider, [
      "https://www.reddit.com/r/gadgets/comments/abc/product_x",
      "https://x.com/leaker/status/2",
    ]);

    expect(items.map((item) => [item.sourceFamily, item.sourceType])).toEqual([
      ["community", "reddit_post"],
      ["community", "x_post"],
    ]);
  });
});
