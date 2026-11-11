import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";

function createCapturedLogger() {
  const records: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      const lines = chunk.toString().split("\n").filter(Boolean);

      for (const line of lines) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      }

      callback();
    },
  });

  return {
    logger: createLogger({
      component: "test",
      destination,
      level: "info",
    }),
    records,
  };
}

describe("structured logging", () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    while (apps.length > 0) {
      const app = apps.pop();
      if (app) {
        await app.close();
      }
    }
  });

  it("emits structured request lifecycle logs with the request id", async () => {
    const { logger, records } = createCapturedLogger();
    const app = buildApp({
      logger,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        "x-request-id": "req-123",
      },
    });

    expect(response.statusCode).toBe(200);

    const completed = records.find((record) => record.event === "request_completed");

    expect(completed).toMatchObject({
      service: "cassandra-api",
      component: "http",
      event: "request_completed",
      reqId: "req-123",
      method: "GET",
      url: "/health",
      statusCode: 200,
    });
    expect(completed?.durationMs).toEqual(expect.any(Number));
  });

  it("defaults to a silent logger in test mode even when an env object is provided", async () => {
    const app = buildApp({
      env: getEnv({
        ...process.env,
        LOG_LEVEL: "info",
      }),
    });
    apps.push(app);

    expect(app.log.level).toBe("silent");
  });

  it("leaves the API key out of logged request headers", () => {
    const { logger, records } = createCapturedLogger();

    logger.info({ req: { headers: { "x-api-key": "s3cret-key", accept: "*/*" } } }, "request received");

    expect(JSON.stringify(records)).not.toContain("s3cret-key");
    expect(records[0]).toMatchObject({ req: { headers: { accept: "*/*" } } });
  });
});
