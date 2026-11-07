import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventRecord } from "../src/modules/events/repository.js";
import { createPolymarketClobProvider } from "../src/modules/evidence/providers/polymarketClob.js";
import { createPolymarketGammaProvider } from "../src/modules/evidence/providers/polymarketGamma.js";

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "event-poly",
    question: "Will the Fed cut rates at the March 2026 meeting?",
    resolutionCriteria: "FOMC statement announces a cut.",
    deadline: "2026-03-31T23:59:59Z",
    status: "active",
    entities: ["Federal Reserve"],
    referenceClass: null,
    marketSymbols: [],
    polymarketMarketId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const fedMarket = {
  id: "1001",
  question: "Fed rate cut by March 2026 meeting?",
  slug: "fed-rate-cut-by-march-2026-meeting",
  conditionId: "0xabc",
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.34", "0.66"]',
  liquidityNum: 125000,
  volumeNum: 900000,
  spread: 0.01,
  closed: false,
};

function stubFetch(routes: Record<string, unknown>) {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      const match = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (!match) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(match[1]), { status: 200 });
    }),
  );
  return requested;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("polymarket gamma provider", () => {
  it("looks up a configured market by slug and exposes its Yes probability and liquidity", async () => {
    const requested = stubFetch({
      "https://gamma.test/markets?slug=fed-rate-cut-by-march-2026-meeting": [fedMarket],
    });

    const items = await createPolymarketGammaProvider({ baseUrl: "https://gamma.test" }).collect({
      event: event({ polymarketMarketId: "fed-rate-cut-by-march-2026-meeting" }),
      evaluationTime: "2026-02-01T00:00:00Z",
      mode: "live",
    });

    expect(requested[0]).toBe("https://gamma.test/markets?slug=fed-rate-cut-by-march-2026-meeting");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Fed rate cut by March 2026 meeting?");
    expect(items[0]?.metadata).toMatchObject({
      probability: 0.34,
      liquidity: 125000,
      conditionId: "0xabc",
      matchedBy: "id",
    });
  });

  it("searches for related open markets and drops unrelated or closed ones", async () => {
    const requested = stubFetch({
      "https://gamma.test/public-search": {
        events: [
          {
            title: "Fed decision in March 2026",
            markets: [
              fedMarket,
              { ...fedMarket, id: "1002", question: "Fed rate cut by January 2026 meeting?", closed: true },
            ],
          },
          {
            title: "Example Corp launches",
            markets: [{ ...fedMarket, id: "2001", question: "Will Example Corp launch Product X?" }],
          },
        ],
      },
    });

    const items = await createPolymarketGammaProvider({ baseUrl: "https://gamma.test" }).collect({
      event: event(),
      evaluationTime: "2026-02-01T00:00:00Z",
      mode: "live",
    });

    expect(requested[0]).toContain("https://gamma.test/public-search?q=");
    expect(items.map((item) => item.metadata.polymarketId)).toEqual(["1001"]);
    expect(items[0]?.metadata.matchedBy).toBe("search");
  });
});

describe("polymarket clob provider", () => {
  it("skips identifiers that are not condition ids without calling the API", async () => {
    const requested = stubFetch({});

    const items = await createPolymarketClobProvider({ baseUrl: "https://clob.test" }).collect({
      event: event({ polymarketMarketId: "fed-rate-cut-by-march-2026-meeting" }),
      evaluationTime: "2026-02-01T00:00:00Z",
      mode: "live",
    });

    expect(items).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("reports the Yes token midpoint as the market probability", async () => {
    stubFetch({
      "https://clob.test/markets/0xabc": {
        condition_id: "0xabc",
        question: "Fed rate cut by March 2026 meeting?",
        tokens: [
          { token_id: "yes-token", outcome: "Yes", price: 0.33 },
          { token_id: "no-token", outcome: "No", price: 0.67 },
        ],
      },
      "https://clob.test/midpoint?token_id=yes-token": { mid: "0.345" },
    });

    const items = await createPolymarketClobProvider({ baseUrl: "https://clob.test" }).collect({
      event: event({ polymarketMarketId: "0xabc" }),
      evaluationTime: "2026-02-01T00:00:00Z",
      mode: "live",
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.metadata).toMatchObject({ probability: 0.345, outcome: "Yes", tokenId: "yes-token" });
  });
});
