import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadProviderFixture } from "../src/modules/evidence/providers/fixtureLoader.js";

describe("loadProviderFixture", () => {
  it("names the missing fixture without exposing the server's filesystem path", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "cassandra-fixtures-"));

    const error = await loadProviderFixture("officialSearch", "FOMC rate cut", fixtureRoot).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('No officialSearch fixture for "fomc-rate-cut"');
    expect((error as Error).message).not.toContain(fixtureRoot);
  });
});
