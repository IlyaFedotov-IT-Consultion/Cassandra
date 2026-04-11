import { describe, expect, it } from "vitest";

import {
  buildConfigScript,
  createWebServer,
  getApiBaseUrl,
  getWebRuntimeConfig,
  readIndexHtml,
} from "../src/server.js";

describe("web server helpers", () => {
  it("exposes the operator console title in the shipped index page", async () => {
    const html = await readIndexHtml();

    expect(html).toContain("Cassandra Operator Console");
    expect(html).toContain("Create Event");
    expect(html).toContain("Create Watchlist");
  });

  it("builds config.js from the configured API base URL", () => {
    const script = buildConfigScript({
      VITE_API_BASE_URL: "http://api.internal:3000",
    });

    expect(script).toContain("http://api.internal:3000");
    expect(getApiBaseUrl({ VITE_API_BASE_URL: "http://api.internal:3000" })).toBe(
      "http://api.internal:3000",
    );
  });

  it("parses runtime config with sane defaults", () => {
    expect(getWebRuntimeConfig({ WEB_PORT: "6123" })).toEqual({
      apiBaseUrl: "http://localhost:3000",
      port: 6123,
    });
  });

  it("creates a node http server instance", () => {
    const server = createWebServer();

    expect(typeof server.listen).toBe("function");
    expect(typeof server.close).toBe("function");

    server.close();
  });
});
