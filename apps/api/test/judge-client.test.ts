import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CalibrationSnapshot, EventRecord } from "@cassandra/shared";

import { getEnv } from "../src/config/env.js";
import { createDbPool } from "../src/lib/db.js";
import { createEvent } from "../src/modules/events/repository.js";
import { createJudgmentRun } from "../src/modules/judgments/repository.js";
import { createJudgeClient, runJudgment } from "../src/modules/judgments/service.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cassandra_test";

interface CapturedRequest {
  path: string;
  headers: IncomingHttpHeaders;
}

const captured: CapturedRequest[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    captured.push({ path: request.url ?? "", headers: request.headers });
    request.resume();
    request.on("end", () => {
      if (request.url === "/plan") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ subQuestions: [], queries: ["example query"], model: null }));
        return;
      }

      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "unavailable" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  captured.length = 0;
});

const event = {
  id: "8f6c2b1e-0d4a-4c1e-9a55-3f0f4f2b9c11",
  question: "Will Example Corp launch Product X by 2026-12-31?",
  resolutionCriteria: "Counts only if Example Corp announces general availability.",
  deadline: "2026-12-31T23:59:59Z",
  entities: ["Example Corp"],
  referenceClass: "product_launch",
  marketSymbols: [],
  polymarketMarketId: null,
} as unknown as EventRecord;

const calibrationSnapshot = { id: "calibration-1", method: "identity", parameters: {} } as unknown as CalibrationSnapshot;

function env() {
  return getEnv({
    DATABASE_URL,
    REDIS_URL: "redis://localhost:6379",
    CASSANDRA_ADAPTER_MODE: "fixture",
    JUDGE_BASE_URL: baseUrl,
  });
}

describe("judge client correlation headers", () => {
  it("sends the judgment and event ids, and a fresh request id, on every judge call", async () => {
    const client = createJudgeClient(env(), { judgmentId: "judgment-42", eventId: event.id });

    await client.plan?.({ event, evaluationTime: "2026-11-07T12:00:00Z", maxQueries: 3 });
    await expect(
      client.judge({
        event,
        evaluationTime: "2026-11-07T12:00:00Z",
        evidence: [],
        calibrationSnapshot,
        mode: "fixture",
      }),
    ).rejects.toThrow(/503/);

    expect(captured.map((request) => request.path)).toEqual(["/plan", "/judge"]);

    for (const request of captured) {
      expect(request.headers["x-cassandra-judgment-id"]).toBe("judgment-42");
      expect(request.headers["x-cassandra-event-id"]).toBe(event.id);
      expect(request.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    }

    expect(captured[0]?.headers["x-request-id"]).not.toBe(captured[1]?.headers["x-request-id"]);
  });

  it("falls back to the event being judged when no context is given", async () => {
    const client = createJudgeClient(env());

    await client.plan?.({ event, evaluationTime: "2026-11-07T12:00:00Z", maxQueries: 3 });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers["x-cassandra-event-id"]).toBe(event.id);
    expect(captured[0]?.headers["x-cassandra-judgment-id"]).toBeUndefined();
  });

  it("names the judge request id when the judge service fails", async () => {
    const client = createJudgeClient(env());

    const failure = await client
      .judge({ event, evaluationTime: "2026-11-07T12:00:00Z", evidence: [], calibrationSnapshot, mode: "fixture" })
      .catch((error: unknown) => error as Error);

    const requestId = captured[0]?.headers["x-request-id"];
    expect(failure).toBeInstanceOf(Error);
    expect(requestId).toEqual(expect.any(String));
    expect((failure as Error).message).toContain(`request ${requestId as string}`);
  });

  it("tags every judge call made by a judgment run with that judgment", async () => {
    const pool = createDbPool(DATABASE_URL);

    try {
      const stored = await createEvent(pool, {
        question: "Will Example Corp launch Product X by 2026-12-31?",
        resolutionCriteria: "Counts only if Example Corp announces general availability.",
        deadline: "2026-12-31T23:59:59Z",
        entities: ["Example Corp"],
        referenceClass: "product_launch",
        marketSymbols: [],
      });
      const judgment = await createJudgmentRun(pool, stored.id);

      await runJudgment({
        pool,
        env: env(),
        input: { eventId: stored.id, judgmentId: judgment.id, evaluationTime: "2026-10-11T12:00:00Z" },
      }).catch(() => undefined);

      expect(captured.length).toBeGreaterThan(0);
      for (const request of captured) {
        expect(request.headers["x-cassandra-judgment-id"]).toBe(judgment.id);
        expect(request.headers["x-cassandra-event-id"]).toBe(stored.id);
      }
    } finally {
      await pool.end();
    }
  });
});
