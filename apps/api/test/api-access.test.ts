import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { getEnv } from "../src/config/env.js";

const WEB_ORIGIN = "http://localhost:5173";

async function withApp<T>(
  envOverrides: Record<string, string>,
  run: (app: ReturnType<typeof buildApp>) => Promise<T>,
): Promise<T> {
  const app = buildApp({ env: getEnv({ CASSANDRA_ADAPTER_MODE: "fixture", ...envOverrides }) });

  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

describe("cross-origin access", () => {
  it("answers a preflight from the local web workspace", async () => {
    await withApp({}, async (app) => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/judgments",
        headers: { origin: WEB_ORIGIN, "access-control-request-method": "POST" },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
      expect(String(response.headers["access-control-allow-headers"])).toContain("x-api-key");
    });
  });

  it("refuses a preflight from an origin that is not on the allowlist", async () => {
    await withApp({}, async (app) => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/judgments",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  it("refuses a request that carries a foreign origin, so no-preflight requests cannot start work", async () => {
    await withApp({}, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/research/runs",
        headers: { origin: "https://evil.example", "content-type": "text/plain" },
        payload: JSON.stringify({ query: "anything" }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatch(/origin/i);
    });
  });

  it("serves requests without an origin, such as curl and the harness", async () => {
    await withApp({}, async (app) => {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    });
  });

  it("takes the allowlist from CASSANDRA_CORS_ORIGINS", async () => {
    await withApp({ CASSANDRA_CORS_ORIGINS: "https://a.example, https://b.example/" }, async (app) => {
      const allowed = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://b.example" } });
      const formerDefault = await app.inject({ method: "GET", url: "/health", headers: { origin: WEB_ORIGIN } });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://b.example");
      expect(formerDefault.statusCode).toBe(403);
    });
  });
});

describe("API key", () => {
  const withKey = { CASSANDRA_API_KEY: "s3cret-key" };

  it("leaves the API open when no key is configured", async () => {
    await withApp({}, async (app) => {
      const response = await app.inject({ method: "GET", url: "/research/runs/unknown" });

      expect(response.statusCode).toBe(404);
    });
  });

  it("rejects requests without the configured key", async () => {
    await withApp(withKey, async (app) => {
      const missing = await app.inject({ method: "GET", url: "/research/runs/unknown" });
      const wrong = await app.inject({
        method: "GET",
        url: "/research/runs/unknown",
        headers: { "x-api-key": "s3cret-kez" },
      });

      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
    });
  });

  it("accepts the key as x-api-key or as a bearer token", async () => {
    await withApp(withKey, async (app) => {
      const header = await app.inject({
        method: "GET",
        url: "/research/runs/unknown",
        headers: { "x-api-key": "s3cret-key" },
      });
      const bearer = await app.inject({
        method: "GET",
        url: "/research/runs/unknown",
        headers: { authorization: "Bearer s3cret-key" },
      });

      expect(header.statusCode).toBe(404);
      expect(bearer.statusCode).toBe(404);
    });
  });

  it("keeps health, readiness and preflights reachable without the key", async () => {
    await withApp(withKey, async (app) => {
      const health = await app.inject({ method: "GET", url: "/health" });
      const ready = await app.inject({ method: "GET", url: "/ready" });
      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/judgments",
        headers: { origin: WEB_ORIGIN, "access-control-request-method": "POST" },
      });

      expect(health.statusCode).toBe(200);
      expect(ready.statusCode).toBe(200);
      expect(preflight.statusCode).toBe(204);
    });
  });
});

describe("listen address", () => {
  it("binds to the loopback interface unless API_HOST says otherwise", () => {
    expect(getEnv({}).API_HOST).toBe("127.0.0.1");
    expect(getEnv({ API_HOST: "0.0.0.0" }).API_HOST).toBe("0.0.0.0");
  });
});
