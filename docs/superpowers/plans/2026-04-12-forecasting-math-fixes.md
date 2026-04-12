# Forecasting Math & Robustness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 5 critical/high mathematical bugs and 2 critical robustness issues identified in the forecasting review (Tier 1 items), plus expand test coverage for the mathematical core.

**Architecture:** Extract aggregation math from `service.ts` into a focused `aggregation.ts` module, fix the math inline, then add comprehensive tests. The dependency discount fix requires restructuring the opinion-building pipeline so the Jaccard matrix is available during opinion construction.

**Tech Stack:** TypeScript, Vitest, pg (Pool/PoolClient)

---

### Task 1: Extract aggregation math into `aggregation.ts`

**Files:**
- Create: `apps/api/src/modules/judgments/aggregation.ts`
- Modify: `apps/api/src/modules/judgments/service.ts`

This task extracts pure math functions out of `service.ts` into a dedicated, testable module. No behavior changes yet — just a move.

- [ ] **Step 1: Create `aggregation.ts` with the extracted math functions**

```ts
import type { JudgeOpinion, VerdictTrace } from "@cassandra/shared";

export function probabilityToLogOdds(p: number): number {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

export function logOddsToProbability(logOdds: number): number {
  return 1 / (1 + Math.exp(-logOdds));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function variance(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const mean = average(values);
  return average(values.map((value) => (value - mean) ** 2));
}

export function computeFreshnessDecay(publishedAt: string, evaluationTime: string): number {
  const ageHours = Math.max(
    0,
    (new Date(evaluationTime).getTime() - new Date(publishedAt).getTime()) / (1000 * 60 * 60),
  );

  return clamp(Math.exp(-ageHours / 168), 0.2, 1);
}

export function computeJaccardOverlap(leftIds: string[], rightIds: string[]): number {
  const leftSet = new Set(leftIds);
  const rightSet = new Set(rightIds);
  const union = new Set([...leftSet, ...rightSet]);
  const intersectionCount = [...leftSet].filter((id) => rightSet.has(id)).length;
  return union.size === 0 ? 0 : intersectionCount / union.size;
}

export function buildDependencyMatrix(judgeOpinions: JudgeOpinion[]): VerdictTrace["dependencyMatrix"] {
  const entries: VerdictTrace["dependencyMatrix"] = [];

  for (let i = 0; i < judgeOpinions.length; i += 1) {
    const left = judgeOpinions[i];

    if (!left) {
      continue;
    }

    for (let j = i + 1; j < judgeOpinions.length; j += 1) {
      const right = judgeOpinions[j];

      if (!right) {
        continue;
      }

      const jaccard = computeJaccardOverlap(left.evidenceIds, right.evidenceIds);
      entries.push({ judgeA: left.judgeName, judgeB: right.judgeName, jaccard });
    }
  }

  return entries;
}

export function computeDependencyDiscount(
  judgeName: string,
  allOpinions: Array<{ judgeName: string; evidenceIds: string[] }>,
): number {
  const self = allOpinions.find((o) => o.judgeName === judgeName);

  if (!self || self.evidenceIds.length === 0) {
    return 1;
  }

  let overlapSum = 0;

  for (const other of allOpinions) {
    if (other.judgeName === judgeName) {
      continue;
    }

    overlapSum += computeJaccardOverlap(self.evidenceIds, other.evidenceIds);
  }

  return 1 / (1 + overlapSum);
}

export function computeDisagreementShrinkage(logBayesFactors: number[]): number {
  return clamp(variance(logBayesFactors) * 0.25, 0, 0.6);
}

export function computePosteriorWithShrinkage(args: {
  rawPosteriorLogOdds: number;
  priorLogOdds: number;
  shrinkage: number;
}): number {
  const posteriorLogOdds =
    (1 - args.shrinkage) * args.rawPosteriorLogOdds +
    args.shrinkage * args.priorLogOdds;
  return logOddsToProbability(posteriorLogOdds);
}
```

- [ ] **Step 2: Update `service.ts` imports to use `aggregation.ts`**

Replace the local definitions of `probabilityToLogOdds`, `logOddsToProbability`, `clamp`, `average`, `variance`, `computeFreshnessDecay`, and `buildDependencyMatrix` with imports from `./aggregation.js`. Delete the local copies from `service.ts`.

Add this import at the top of `service.ts`:

```ts
import {
  probabilityToLogOdds,
  logOddsToProbability,
  clamp,
  average,
  variance,
  computeFreshnessDecay,
  buildDependencyMatrix,
  computeDependencyDiscount,
  computeDisagreementShrinkage,
  computePosteriorWithShrinkage,
} from "./aggregation.js";
```

Remove these function definitions from `service.ts`:
- `probabilityToLogOdds` (around line 337)
- `logOddsToProbability` (around line 341)
- `clamp` (around line 331)
- `average` (around line 364)
- `variance` (around line 372)
- `computeFreshnessDecay` (around line 421)
- `buildDependencyMatrix` (around line 430)

- [ ] **Step 3: Run tests to verify no regressions**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test`
Expected: All existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/judgments/aggregation.ts apps/api/src/modules/judgments/service.ts
git commit -m "refactor(judgments): extract aggregation math into dedicated module"
```

---

### Task 2: Write failing tests for aggregation math

**Files:**
- Create: `apps/api/test/aggregation.test.ts`

- [ ] **Step 1: Write tests for log-odds transforms, dependency discount, shrinkage, and posterior**

```ts
import { describe, expect, it } from "vitest";

import {
  probabilityToLogOdds,
  logOddsToProbability,
  clamp,
  average,
  variance,
  computeFreshnessDecay,
  computeJaccardOverlap,
  computeDependencyDiscount,
  computeDisagreementShrinkage,
  computePosteriorWithShrinkage,
} from "../src/modules/judgments/aggregation.js";

describe("log-odds transforms", () => {
  it("round-trips probability through log-odds", () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(logOddsToProbability(probabilityToLogOdds(p))).toBeCloseTo(p, 10);
    }
  });

  it("clamps probability near 0 for probabilityToLogOdds", () => {
    const result = probabilityToLogOdds(0);
    expect(result).toBeLessThan(-10);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("clamps probability near 1 for probabilityToLogOdds", () => {
    const result = probabilityToLogOdds(1);
    expect(result).toBeGreaterThan(10);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("handles very large positive log-odds", () => {
    expect(logOddsToProbability(100)).toBeCloseTo(1, 6);
  });

  it("handles very large negative log-odds", () => {
    expect(logOddsToProbability(-100)).toBeCloseTo(0, 6);
  });

  it("logOddsToProbability(0) returns 0.5", () => {
    expect(logOddsToProbability(0)).toBe(0.5);
  });
});

describe("computeFreshnessDecay", () => {
  it("returns 1.0 when publishedAt equals evaluationTime", () => {
    const t = "2026-04-12T12:00:00Z";
    expect(computeFreshnessDecay(t, t)).toBe(1);
  });

  it("returns clamped minimum 0.2 for very old evidence", () => {
    expect(
      computeFreshnessDecay("2020-01-01T00:00:00Z", "2026-04-12T12:00:00Z"),
    ).toBe(0.2);
  });

  it("returns 1.0 when publishedAt is in the future", () => {
    expect(
      computeFreshnessDecay("2026-04-13T00:00:00Z", "2026-04-12T00:00:00Z"),
    ).toBe(1);
  });

  it("decays by approximately half at 168 hours", () => {
    const evalTime = "2026-04-19T12:00:00Z";
    const pubTime = "2026-04-12T12:00:00Z";
    const result = computeFreshnessDecay(pubTime, evalTime);
    expect(result).toBeCloseTo(Math.exp(-1), 4);
  });
});

describe("computeJaccardOverlap", () => {
  it("returns 0 for disjoint sets", () => {
    expect(computeJaccardOverlap(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(computeJaccardOverlap(["a", "b"], ["a", "b"])).toBe(1);
  });

  it("returns 0 for two empty sets", () => {
    expect(computeJaccardOverlap([], [])).toBe(0);
  });

  it("returns correct value for partial overlap", () => {
    expect(computeJaccardOverlap(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5, 10);
  });
});

describe("computeDependencyDiscount", () => {
  it("returns 1 when judge has no evidence", () => {
    const opinions = [
      { judgeName: "a", evidenceIds: [] },
      { judgeName: "b", evidenceIds: ["x"] },
    ];
    expect(computeDependencyDiscount("a", opinions)).toBe(1);
  });

  it("returns 1 when no overlap with other judges", () => {
    const opinions = [
      { judgeName: "a", evidenceIds: ["x"] },
      { judgeName: "b", evidenceIds: ["y"] },
    ];
    expect(computeDependencyDiscount("a", opinions)).toBe(1);
  });

  it("returns ~0.5 when two judges cite identical evidence", () => {
    const opinions = [
      { judgeName: "a", evidenceIds: ["x", "y"] },
      { judgeName: "b", evidenceIds: ["x", "y"] },
    ];
    expect(computeDependencyDiscount("a", opinions)).toBeCloseTo(0.5, 10);
  });

  it("discounts proportionally to overlap sum", () => {
    const opinions = [
      { judgeName: "a", evidenceIds: ["x", "y"] },
      { judgeName: "b", evidenceIds: ["x"] },
      { judgeName: "c", evidenceIds: ["y"] },
    ];
    const discount = computeDependencyDiscount("a", opinions);
    expect(discount).toBeGreaterThan(0);
    expect(discount).toBeLessThan(1);
  });
});

describe("computeDisagreementShrinkage", () => {
  it("returns 0 for identical log Bayes factors", () => {
    expect(computeDisagreementShrinkage([1.5, 1.5, 1.5])).toBe(0);
  });

  it("clamps at 0.6 for very high variance", () => {
    expect(computeDisagreementShrinkage([-3, 0, 3])).toBe(0.6);
  });

  it("returns 0 for empty array", () => {
    expect(computeDisagreementShrinkage([])).toBe(0);
  });
});

describe("computePosteriorWithShrinkage", () => {
  it("returns prior probability when shrinkage is 1", () => {
    const priorLogOdds = probabilityToLogOdds(0.3);
    const result = computePosteriorWithShrinkage({
      rawPosteriorLogOdds: probabilityToLogOdds(0.8),
      priorLogOdds,
      shrinkage: 1,
    });
    expect(result).toBeCloseTo(0.3, 6);
  });

  it("returns raw posterior when shrinkage is 0", () => {
    const result = computePosteriorWithShrinkage({
      rawPosteriorLogOdds: probabilityToLogOdds(0.8),
      priorLogOdds: probabilityToLogOdds(0.3),
      shrinkage: 0,
    });
    expect(result).toBeCloseTo(0.8, 6);
  });

  it("blends toward prior, not toward 0.5", () => {
    const prior = 0.7;
    const result = computePosteriorWithShrinkage({
      rawPosteriorLogOdds: probabilityToLogOdds(0.9),
      priorLogOdds: probabilityToLogOdds(prior),
      shrinkage: 0.5,
    });
    expect(result).toBeGreaterThan(prior);
    expect(result).toBeLessThan(0.9);
    expect(result).not.toBeCloseTo(0.5, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test -- aggregation`
Expected: All tests pass (these test the extracted pure functions which are correct in isolation — the bugs are in how `service.ts` uses them).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/aggregation.test.ts
git commit -m "test(aggregation): add comprehensive tests for aggregation math"
```

---

### Task 3: Fix disagreement shrinkage (review items 2.1 and 2.5)

**Files:**
- Modify: `apps/api/src/modules/judgments/service.ts:881-948` — `buildFixtureVerdictTrace`

- [ ] **Step 1: Fix `buildFixtureVerdictTrace` shrinkage to use log Bayes factors and shrink toward prior**

In `service.ts`, replace the shrinkage and final probability computation (around lines 908-909):

Old:
```ts
  const disagreementShrinkage = clamp(variance(judgeOpinions.map((opinion) => opinion.probability)) * 0.25, 0, 0.6);
  const finalProbability = logOddsToProbability(rawPosteriorLogOdds * (1 - disagreementShrinkage));
```

New:
```ts
  const disagreementShrinkage = computeDisagreementShrinkage(
    judgeOpinions.map((opinion) => opinion.logBayesFactor),
  );
  const priorLogOdds = probabilityToLogOdds(priorProbability);
  const finalProbability = computePosteriorWithShrinkage({
    rawPosteriorLogOdds,
    priorLogOdds,
    shrinkage: disagreementShrinkage,
  });
```

- [ ] **Step 2: Run tests**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/judgments/service.ts
git commit -m "fix(judgments): shrink disagreement toward prior instead of 0.5, use log-odds variance"
```

---

### Task 4: Fix dependency discount to use Jaccard formula (review item 2.4)

**Files:**
- Modify: `apps/api/src/modules/judgments/service.ts:825-879` — `buildJudgeOpinion`
- Modify: `apps/api/src/modules/judgments/service.ts:881-948` — `buildFixtureVerdictTrace`

The design requires `dependency_discount_j = 1 / (1 + sum_of_jaccard_overlaps)`. The current code computes this as `1 / evidence.length` inside `buildJudgeOpinion` before other judges are known. The fix: build preliminary opinions without dependency discount, then compute the Jaccard matrix, then apply the discount.

- [ ] **Step 1: Restructure `buildJudgeOpinion` to accept a dependency discount parameter**

In `service.ts`, change `buildJudgeOpinion` to accept an optional `dependencyDiscount` argument instead of computing it internally. Replace line 838:

Old:
```ts
  const dependencyDiscount = args.evidence.length > 1 ? 1 / args.evidence.length : 1;
```

New:
```ts
  const dependencyDiscount = args.dependencyDiscount ?? 1;
```

And add `dependencyDiscount?: number;` to the function's args type.

- [ ] **Step 2: Update `buildFixtureVerdictTrace` to compute dependency discounts from Jaccard overlaps**

In `buildFixtureVerdictTrace`, restructure the pipeline to:
1. Build preliminary judge data (evidence sets per judge).
2. Compute Jaccard-based dependency discounts.
3. Build final opinions with the correct discounts.

Replace the opinion-building block (around lines 889-900):

Old:
```ts
  const judgeOpinions = PANEL_JUDGES.map((panelJudge) =>
    buildJudgeOpinion({
      judgeName: panelJudge.judgeName,
      evidence: args.evidence.filter((item) => {
        return (panelJudge.sourceFamilies as readonly SourceFamily[]).includes(item.sourceFamily);
      }),
      calibrationSnapshot: args.calibrationSnapshot,
      evaluationTime: args.evaluationTime,
      missingSourceFamily: panelJudge.missingSourceFamily,
    }),
  );
  const dependencyMatrix = buildDependencyMatrix(judgeOpinions);
```

New:
```ts
  const judgeEvidenceSets = PANEL_JUDGES.map((panelJudge) => ({
    judgeName: panelJudge.judgeName,
    evidence: args.evidence.filter((item) =>
      (panelJudge.sourceFamilies as readonly SourceFamily[]).includes(item.sourceFamily),
    ),
    missingSourceFamily: panelJudge.missingSourceFamily,
  }));
  const evidenceIdSets = judgeEvidenceSets.map((j) => ({
    judgeName: j.judgeName,
    evidenceIds: j.evidence.map((e) => e.id),
  }));
  const judgeOpinions = judgeEvidenceSets.map((j) =>
    buildJudgeOpinion({
      judgeName: j.judgeName,
      evidence: j.evidence,
      calibrationSnapshot: args.calibrationSnapshot,
      evaluationTime: args.evaluationTime,
      missingSourceFamily: j.missingSourceFamily,
      dependencyDiscount: computeDependencyDiscount(j.judgeName, evidenceIdSets),
    }),
  );
  const dependencyMatrix = buildDependencyMatrix(judgeOpinions);
```

- [ ] **Step 3: Apply the same fix to `buildInsufficientEvidenceVerdictTrace`**

In `buildInsufficientEvidenceVerdictTrace` (around line 747), apply the same restructuring pattern. Since this function passes empty evidence to all judges, the dependency discounts will all be 1 (no overlap), so the result is equivalent — but apply the pattern for consistency.

- [ ] **Step 4: Run tests**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/judgments/service.ts
git commit -m "fix(judgments): use Jaccard-based dependency discount instead of 1/evidence.length"
```

---

### Task 5: Fix judge probability heuristic (review item 2.5)

**Files:**
- Modify: `apps/api/src/modules/judgments/service.ts:825-879` — `buildJudgeOpinion`

- [ ] **Step 1: Replace the linear heuristic with a proper log-odds-derived probability**

In `buildJudgeOpinion`, replace the probability computation (around lines 849-853):

Old:
```ts
  const probability = clamp(
    0.5 + effectiveLogOddsContribution * 0.18 + args.evidence.length * 0.02,
    0.05,
    0.95,
  );
```

New:
```ts
  const probability = clamp(logOddsToProbability(logBayesFactor), 0.05, 0.95);
```

This computes the judge's probability from its log Bayes factor directly, which represents the posterior probability if the prior were 0.5. The probability no longer has a bias from evidence count.

- [ ] **Step 2: Run tests**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/judgments/service.ts
git commit -m "fix(judgments): derive judge probability from log Bayes factor instead of linear heuristic"
```

---

### Task 6: Fix transaction handling in `appendJudgmentTrace` (review item 4.1)

**Files:**
- Modify: `apps/api/src/modules/judgments/repository.ts:95-164` — `appendJudgmentTrace`

- [ ] **Step 1: Replace `pool.query` with explicit client for transaction**

Replace the `appendJudgmentTrace` function:

Old:
```ts
export async function appendJudgmentTrace(
  pool: Pool,
  judgmentId: string,
  verdictTrace: VerdictTrace,
): Promise<void> {
  await pool.query("BEGIN");

  try {
    await pool.query(
      `
        UPDATE judgments
        SET status = $2, verdict_trace = $3::jsonb, updated_at = NOW()
        WHERE id = $1
      `,
      [judgmentId, verdictTrace.status, JSON.stringify(verdictTrace)],
    );

    await pool.query(`DELETE FROM judge_opinions WHERE judgment_id = $1`, [judgmentId]);

    for (const opinion of verdictTrace.judgeOpinions) {
      await pool.query(
```

New:
```ts
export async function appendJudgmentTrace(
  pool: Pool,
  judgmentId: string,
  verdictTrace: VerdictTrace,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE judgments
        SET status = $2, verdict_trace = $3::jsonb, updated_at = NOW()
        WHERE id = $1
      `,
      [judgmentId, verdictTrace.status, JSON.stringify(verdictTrace)],
    );

    await client.query(`DELETE FROM judge_opinions WHERE judgment_id = $1`, [judgmentId]);

    for (const opinion of verdictTrace.judgeOpinions) {
      await client.query(
```

Replace every remaining `pool.query` inside this function with `client.query`, and change the catch/finally block:

Old:
```ts
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
```

New:
```ts
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/judgments/repository.ts
git commit -m "fix(judgments): use explicit client connection for appendJudgmentTrace transaction"
```

---

### Task 7: Add timeout to judge service HTTP call and evidence providers (review item 4.2)

**Files:**
- Modify: `apps/api/src/modules/judgments/service.ts` — `DefaultJudgeClient.judge` (around line 967)
- Modify: `apps/api/src/modules/evidence/providers/perplexity.ts`
- Modify: `apps/api/src/modules/evidence/providers/polymarketGamma.ts`
- Modify: `apps/api/src/modules/evidence/providers/polymarketClob.ts`
- Modify: `apps/api/src/modules/evidence/providers/officialSearch.ts`
- Modify: `apps/api/src/modules/evidence/providers/governmentSearch.ts`
- Modify: `apps/api/src/modules/evidence/providers/communitySearch.ts`
- Modify: `apps/api/src/modules/evidence/providers/web.ts`
- Modify: `apps/api/src/modules/evidence/providers/marketProvider.ts`

- [ ] **Step 1: Add AbortController timeout to judge service fetch**

In `DefaultJudgeClient.judge`, wrap the fetch call with a timeout (around line 967):

Old:
```ts
    const response = await fetch(`${this.env.JUDGE_BASE_URL}/judge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
```

New:
```ts
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const response = await fetch(`${this.env.JUDGE_BASE_URL}/judge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
```

Add `clearTimeout(timeout)` after the response is received, and close the try block with the appropriate `finally { clearTimeout(timeout); }`.

- [ ] **Step 2: Add AbortController timeout to each evidence provider that lacks one**

For each provider file (perplexity, polymarketGamma, polymarketClob, officialSearch, governmentSearch, communitySearch, web, marketProvider), find the `fetch()` call and wrap it with an `AbortController` and 60-second timeout, following the same pattern used in `zaiCli.ts`:

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);

try {
  const response = await fetch(url, {
    ...existingOptions,
    signal: controller.signal,
  });
  // ... existing response handling ...
} finally {
  clearTimeout(timeout);
}
```

Note: The ZAI-backed providers (officialSearch, governmentSearch, communitySearch, web) delegate to `searchWithZaiCli` which already has timeout handling. Only add timeouts to providers that use their own direct `fetch` calls: perplexity, polymarketGamma, polymarketClob, and marketProvider.

- [ ] **Step 3: Run tests**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/judgments/service.ts apps/api/src/modules/evidence/providers/
git commit -m "fix(judgments): add timeout to judge service and evidence provider HTTP calls"
```

---

### Task 8: Expand metrics test coverage (review item 5.1 and 5.2)

**Files:**
- Modify: `apps/api/test/evaluation-metrics.test.ts`

- [ ] **Step 1: Add edge case tests for metrics**

Add the following tests to `apps/api/test/evaluation-metrics.test.ts`:

```ts
  it("handles empty pairs for all metrics", () => {
    expect(brierScore([])).toBe(0);
    expect(logLoss([])).toBe(0);
    expect(averageAbsoluteError([])).toBe(0);
    expect(winRateVsReference([])).toBe(0);
    expect(calibrationBins([])).toEqual([]);
    expect(expectedCalibrationError([])).toBe(0);
  });

  it("computes brier score of 0 for perfect predictions", () => {
    const perfect = [
      { predicted: 1, outcome: 1 },
      { predicted: 0, outcome: 0 },
    ];
    expect(brierScore(perfect)).toBe(0);
  });

  it("computes brier score of 1 for worst predictions", () => {
    const worst = [
      { predicted: 0, outcome: 1 },
      { predicted: 1, outcome: 0 },
    ];
    expect(brierScore(worst)).toBe(1);
  });

  it("computes log loss with boundary predictions clamped", () => {
    const boundary = [
      { predicted: 0, outcome: 1 },
      { predicted: 1, outcome: 0 },
    ];
    const loss = logLoss(boundary);
    expect(Number.isFinite(loss)).toBe(true);
    expect(loss).toBeGreaterThan(0);
  });

  it("computes win rate of 0 when model always loses", () => {
    const losing = [
      { predicted: 0.9, outcome: 0, referencePredicted: 0.1 },
      { predicted: 0.1, outcome: 1, referencePredicted: 0.9 },
    ];
    expect(winRateVsReference(losing)).toBe(0);
  });

  it("computes win rate of 0.5 on ties (conservative — ties are not wins)", () => {
    const tied = [
      { predicted: 0.5, outcome: 1, referencePredicted: 0.5 },
      { predicted: 0.8, outcome: 1, referencePredicted: 0.6 },
    ];
    expect(winRateVsReference(tied)).toBe(0.5);
  });

  it("handles calibration bins with single-bin edge case", () => {
    const bins = calibrationBins(pairs, 1);
    expect(bins).toHaveLength(1);
    expect(bins[0]?.sampleSize).toBe(4);
  });

  it("handles slice metrics with no matching baseline", () => {
    const slices = sliceMetrics(pairs, {
      key: "theme",
      baseline: "base_rate_only" as any,
    });
    expect(slices).toEqual([]);
  });

  it("handles averageAbsoluteError for all-correct predictions", () => {
    const correct = [
      { predicted: 1, outcome: 1 },
      { predicted: 0, outcome: 0 },
    ];
    expect(averageAbsoluteError(correct)).toBe(0);
  });
```

- [ ] **Step 2: Run tests**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test -- evaluation-metrics`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/evaluation-metrics.test.ts
git commit -m "test(metrics): add edge case coverage for scoring rules and calibration bins"
```

---

### Task 9: Fix dead code in `computeBaseRateOnlyProbability` (review item 4.7)

**Files:**
- Modify: `apps/api/src/modules/evaluation/baselines.ts:67-105`

- [ ] **Step 1: Write a failing test for sparse class shrinkage**

Add to `apps/api/test/evaluation-baselines.test.ts`:

```ts
  it("shrinks sparse reference classes toward global prior of 0.5", () => {
    const result = computeBaseRateOnlyProbability({
      referenceClass: "rare_class",
      calibrationSnapshot: {
        ...buildCalibrationSnapshot(),
        baseRateParams: {
          minimumSample: 20,
          historicalCounts: {
            rare_class: { successes: 2, total: 3 },
          },
        },
      },
    });
    const rawSmoothed = (2 + 1) / (3 + 2);
    expect(result).not.toBeCloseTo(rawSmoothed, 6);
    expect(result).toBeGreaterThan(0.5);
    expect(result).toBeLessThan(rawSmoothed);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test -- evaluation-baselines`
Expected: FAIL — currently both branches return the same `smoothed` value.

- [ ] **Step 3: Implement sparse class shrinkage**

In `baselines.ts`, fix `computeBaseRateOnlyProbability`:

Old:
```ts
  if (total < minimumSample) {
    return smoothed;
  }

  return smoothed;
```

New:
```ts
  if (total < minimumSample) {
    const shrinkageWeight = total / minimumSample;
    return shrinkageWeight * smoothed + (1 - shrinkageWeight) * 0.5;
  }

  return smoothed;
```

This linearly blends the smoothed rate toward 0.5 (global prior) proportional to how far below `minimumSample` the count is.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ilya/Documents/Cassandra && pnpm --filter @cassandra/api test -- evaluation-baselines`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/evaluation/baselines.ts apps/api/test/evaluation-baselines.test.ts
git commit -m "fix(baselines): shrink sparse reference classes toward global prior"
```
