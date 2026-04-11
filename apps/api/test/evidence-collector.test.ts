import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDbPool } from "../src/lib/db.js";
import { collectEvidenceForEvent } from "../src/modules/evidence/collector.js";
import { createMarketProvider } from "../src/modules/evidence/providers/marketProvider.js";
import { createPerplexityProvider } from "../src/modules/evidence/providers/perplexity.js";
import { listEvidenceForEvent } from "../src/modules/evidence/repository.js";
import { createEvent } from "../src/modules/events/repository.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra";

const pool = createDbPool(DATABASE_URL);

async function resetDatabase() {
  await pool.query(`
    TRUNCATE TABLE
      judge_opinions,
      judgments,
      evidence_items,
      outcomes,
      candidate_events,
      calibration_snapshots,
      events,
      watchlists
    RESTART IDENTITY CASCADE
  `);
}

describe("collectEvidenceForEvent", () => {
  beforeAll(async () => {
    await pool.query("select 1");
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("collects fixture-backed provider output, normalizes it, and persists evidence", async () => {
    const event = await createEvent(pool, {
      question: "Will Example Corp launch Product X by 2026-12-31?",
      resolutionCriteria:
        "Counts only if Example Corp posts a general availability announcement on its official site.",
      deadline: "2026-12-31T23:59:59Z",
      entities: ["Example Corp", "Product X"],
      referenceClass: "product_launch",
      marketSymbols: ["EXMPL"],
      polymarketMarketId: "poly-1",
    });

    const result = await collectEvidenceForEvent({
      pool,
      event,
      evaluationTime: "2026-10-11T12:00:00Z",
      mode: "fixture",
      providers: [createPerplexityProvider(), createMarketProvider()],
    });

    expect(result.items).toHaveLength(2);
    expect(result.providerRuns).toEqual([
      expect.objectContaining({
        providerName: "perplexity",
        cacheStatus: "bypass",
        rawCount: 1,
      }),
      expect.objectContaining({
        providerName: "marketProvider",
        cacheStatus: "bypass",
        rawCount: 1,
      }),
    ]);

    const persisted = await listEvidenceForEvent(pool, event.id);

    expect(persisted).toHaveLength(2);
    expect(persisted.map((item) => item.sourceFamily).sort()).toEqual(["llm_research", "market"]);
    expect(persisted[0]?.url.includes("utm_")).toBe(false);
  });
});
