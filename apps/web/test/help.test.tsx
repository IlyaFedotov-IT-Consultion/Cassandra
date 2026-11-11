import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = path === "/health" ? { status: "ok", adapterMode: "live" }
      : path === "/ready" ? { status: "ready" } : [];
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider>);
}

it("lets a new user open contextual guidance and follow it to the full guide without starting a run", async () => {
  const user = userEvent.setup();
  renderAt("/events");
  const summary = await screen.findByText("How events work");
  expect(screen.getByText(/Creating an event saves the question/)).not.toBeVisible();
  await user.click(summary);
  expect(screen.getByText(/Creating an event saves the question/)).toBeVisible();
  await user.click(screen.getByRole("link", { name: "Read the events guide" }));
  expect(await screen.findByRole("heading", { name: "How Cassandra works" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Reading a prediction" })).toBeVisible();
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("keeps help accessible from navigation when the API is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("API offline"); }));
  const user = userEvent.setup();
  renderAt("/events");
  await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Help" }));
  expect(await screen.findByRole("heading", { name: "How Cassandra works" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Troubleshooting and costs" })).toBeVisible();
});

it("associates event field hints with controls without changing their accessible names", async () => {
  const user = userEvent.setup();
  renderAt("/events");
  await user.click(await screen.findByRole("button", { name: "Create event" }));
  expect(screen.getByRole("textbox", { name: "Question" })).toHaveAccessibleDescription(/Yes or No/);
  expect(screen.getByLabelText("Deadline", { exact: true })).toHaveAccessibleDescription(/local time/);
  expect(screen.getByRole("textbox", { name: "Polymarket Market ID" })).toHaveAccessibleDescription(/exact binary market/);
});
