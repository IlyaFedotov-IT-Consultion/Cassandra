import { describe, expect, it } from "vitest";

import { formatDateTime, humanizeToken } from "../src/format";

describe("display formatting", () => {
  it("humanizes underscore-delimited tokens", () => {
    expect(humanizeToken("product_launch")).toBe("Product launch");
    expect(humanizeToken("strong_for")).toBe("Strong for");
  });

  it("formats timestamps in a stable UTC editorial style", () => {
    expect(formatDateTime("2026-12-31T23:59:59Z")).toBe("Dec 31, 2026, 11:59 PM UTC");
  });

  it("returns the original value when a timestamp cannot be parsed", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});
