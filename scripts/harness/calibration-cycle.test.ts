import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const exec = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function fakeApi() {
  const requests: string[] = [];
  let resumed = false;
  const server = createServer((request, response) => {
    const key = `${request.method} ${request.url}`;
    requests.push(key);
    response.setHeader("content-type", "application/json");
    if (key === "GET /health") return response.end(JSON.stringify({ adapterMode: "live" }));
    if (key === "POST /evaluation/runs/existing/resume") resumed = true;
    if (request.url?.startsWith("/evaluation/runs/existing")) {
      return response.end(JSON.stringify({ id: "existing", status: resumed ? "completed" : "failed", progress: { completedMarkets: 1, totalMarkets: 1 } }));
    }
    if (key === "POST /backtests/retrain") {
      return response.end(JSON.stringify({ id: "test-snapshot", weightRegime: "cold_start", resolvedOutcomeCount: 1, approved: false,
        judgeWeights: {}, calibrationParams: { method: "identity" }, marketPriorParams: {}, metrics: {} }));
    }
    response.statusCode = 500;
    response.end(JSON.stringify({ error: `Unexpected request: ${key}` }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test API address");
  return { requests, url: `http://127.0.0.1:${address.port}` };
}

it("makes no requests without confirmation, including when resuming", async () => {
  const api = await fakeApi();
  const result = await exec(process.execPath, ["--import", "tsx", "scripts/harness/calibration-cycle.mts"], {
    env: { ...process.env, API_BASE: api.url, CASSANDRA_API_KEY: "", CALIBRATION_CONFIRM: "", CALIBRATION_RUN_ID: "existing" },
  });
  expect(result.stdout).toContain("nothing was run");
  expect(api.requests).toEqual([]);
});

it("resumes an existing failed run without importing or creating another run", async () => {
  const api = await fakeApi();
  const result = await exec(process.execPath, ["--import", "tsx", "scripts/harness/calibration-cycle.mts"], {
    env: { ...process.env, API_BASE: api.url, CASSANDRA_API_KEY: "", CALIBRATION_CONFIRM: "yes", CALIBRATION_RUN_ID: "existing" },
  });
  expect(result.stdout).toContain("snapshot test-snapshot (not approved)");
  expect(api.requests).toEqual([
    "GET /health", "GET /evaluation/runs/existing", "POST /evaluation/runs/existing/resume",
    "GET /evaluation/runs/existing", "POST /backtests/retrain",
  ]);
});
