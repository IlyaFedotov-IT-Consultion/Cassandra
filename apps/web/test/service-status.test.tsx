import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ServiceStatus } from "../src/components/shell";

let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
});

afterEach(() => {
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderStatus() {
  render(<QueryClientProvider client={client}><ServiceStatus /></QueryClientProvider>);
}

it("recovers from not-ready fixture mode to ready live mode without navigation or reload", async () => {
  let recovered = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const health = String(input).endsWith("/health");
    const body = health ? { status: "ok", adapterMode: recovered ? "live" : "fixture" }
      : recovered ? { status: "ready" } : { status: "not_ready", error: "Database is starting" };
    return new Response(JSON.stringify(body), {
      status: health || recovered ? 200 : 503,
      headers: { "content-type": "application/json" },
    });
  }));
  renderStatus();
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(screen.getByText("API not ready")).toBeVisible();
  expect(screen.getByText("Fixture mode")).toBeVisible();

  recovered = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_100); });
  expect(screen.getByText("API ready")).toBeVisible();
  expect(screen.getByText("Live mode")).toBeVisible();
  expect(screen.queryByText("Database is starting")).not.toBeInTheDocument();
});

it("does not present a cached mode as current after the health endpoint becomes unreachable", async () => {
  let offline = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (offline) throw new Error("Connection lost");
    const body = String(input).endsWith("/health")
      ? { status: "ok", adapterMode: "live" } : { status: "ready" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }));
  renderStatus();
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(screen.getByText("API ready")).toBeVisible();
  expect(screen.getByText("Live mode")).toBeVisible();

  offline = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_100); });
  expect(screen.getByText("API unreachable")).toBeVisible();
  expect(screen.queryByText("Live mode")).not.toBeInTheDocument();
});
