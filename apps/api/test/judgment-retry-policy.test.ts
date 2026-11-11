import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isTransientJudgmentFailure } from "../src/modules/judgments/jobQueue.js";
import { JudgeServiceError } from "../src/modules/judgments/service.js";

function schemaFailure(): unknown {
  return z.object({ id: z.string() }).safeParse({}).error;
}

describe("which judgment failures are worth a paid retry", () => {
  it.each([
    ["the judge service was overloaded", new JudgeServiceError("Judge service returned 503", 503)],
    ["the judge service rate-limited the call", new JudgeServiceError("Judge service returned 429", 429)],
    ["the request timed out", Object.assign(new Error("This operation was aborted"), { name: "AbortError" })],
    [
      "the judge service was unreachable",
      Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }),
    ],
    ["every evidence provider failed", new Error("All 3 evidence provider(s) failed in live mode: web: 502")],
  ])("retries when %s", (_label, error) => {
    expect(isTransientJudgmentFailure(error)).toBe(true);
  });

  it.each([
    ["the judge rejected the request", new JudgeServiceError("Judge service returned 422", 422)],
    ["the judge's answer did not match the schema", schemaFailure()],
    ["the event is gone", new Error("Event not found: 123")],
    ["the cause is unknown", new Error("something else")],
  ])("does not retry when %s", (_label, error) => {
    expect(isTransientJudgmentFailure(error)).toBe(false);
  });
});
