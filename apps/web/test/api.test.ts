import { describe, expect, it, vi } from "vitest";

import { extractApiErrorMessage, resolveApiBaseUrl } from "../src/api";

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

describe("extractApiErrorMessage", () => {
  it("prefers structured error and message fields", () => {
    expect(extractApiErrorMessage({ error: "Bad request" }, 400)).toBe("Bad request");
    expect(extractApiErrorMessage({ message: "Validation failed" }, 422)).toBe("Validation failed");
  });

  it("extracts first detail message from array-style payloads", () => {
    expect(
      extractApiErrorMessage(
        {
          detail: [{ msg: "Field required" }],
        },
        422,
      ),
    ).toBe("Field required");
  });

  it("falls back to the http status when no detail is available", () => {
    expect(extractApiErrorMessage({}, 503)).toBe("Request failed with 503");
  });
});

describe("response validation errors", () => {
  it("explains which field of which endpoint was malformed instead of dumping schema issues", async () => {
    const { listEvents } = await import("../src/api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([{ id: "event-1" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(listEvents()).rejects.toThrow(
      /^The API returned an unexpected response from \/events \(0\.question: .+\)\.$/,
    );
    vi.unstubAllGlobals();
  });
});

describe("recording outcomes", () => {
  it("posts the resolved outcome for an event", async () => {
    const { recordOutcome } = await import("../src/api");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({ id: "outcome-1", createdAt: "2026-11-07T12:00:00Z", ...JSON.parse(String(init?.body)) }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await recordOutcome({
      eventId: "event-1",
      resolvedValue: true,
      resolvedAt: "2026-11-07T12:00:00.000Z",
      resolutionSourceUrl: "https://example.com/resolution",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/outcomes$/);
    expect(outcome).toMatchObject({ id: "outcome-1", resolvedValue: true });
    vi.unstubAllGlobals();
  });
});

describe("API key", () => {
  async function requestHeaders(): Promise<Headers> {
    const { listEvents } = await import("../src/api");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listEvents();

    vi.unstubAllGlobals();
    return new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  }

  it("sends the configured key with every request", async () => {
    vi.stubEnv("VITE_API_KEY", "s3cret-key");

    expect((await requestHeaders()).get("x-api-key")).toBe("s3cret-key");

    vi.unstubAllEnvs();
  });

  it("sends no key header when none is configured", async () => {
    vi.stubEnv("VITE_API_KEY", "");

    expect((await requestHeaders()).has("x-api-key")).toBe(false);

    vi.unstubAllEnvs();
  });
});
