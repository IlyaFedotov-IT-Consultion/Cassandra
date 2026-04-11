import { describe, expect, it } from "vitest";

import { resolveApiBaseUrl } from "../src/api";

describe("resolveApiBaseUrl", () => {
  it("maps Docker-internal api host to the browser host", () => {
    expect(
      resolveApiBaseUrl("http://api:3000", {
        hostname: "localhost",
        origin: "http://localhost:5173",
        protocol: "http:",
      }),
    ).toBe("http://localhost:3000");
  });

  it("preserves configured localhost targets", () => {
    expect(
      resolveApiBaseUrl("http://localhost:3000", {
        hostname: "localhost",
        origin: "http://localhost:5173",
        protocol: "http:",
      }),
    ).toBe("http://localhost:3000");
  });

  it("uses the browser network host when the app is opened from another machine", () => {
    expect(
      resolveApiBaseUrl("http://api:3000", {
        hostname: "192.168.1.50",
        origin: "http://192.168.1.50:5173",
        protocol: "http:",
      }),
    ).toBe("http://192.168.1.50:3000");
  });
});
