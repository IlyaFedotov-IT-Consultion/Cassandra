# Cassandra Forecasting System Review

**Date:** 2026-04-12
**Scope:** Forecasting math, aggregation pipeline, evaluation metrics, architecture vs design spec, test coverage, evidence providers, and operational robustness
**Baseline:** `docs/designs/2026-04-11-multisource-forecast-judge-solution-design.md`
**Reviewer:** Automated code review

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Mathematical Bugs](#2-critical-mathematical-bugs)
3. [Architectural Issues and Missing Features vs Design](#3-architectural-issues-and-missing-features-vs-design)
4. [Robustness and Correctness Concerns](#4-robustness-and-correctness-concerns)
5. [Test Coverage Gaps](#5-test-coverage-gaps)
6. [Security and Operational Concerns](#6-security-and-operational-concerns)
7. [Design Alignment Matrix](#7-design-alignment-matrix)
8. [Priority Recommendations](#8-priority-recommendations)
9. [Detailed Findings](#9-detailed-findings)

---

## 1. Executive Summary

The Cassandra forecasting prototype has a solid foundation: well-defined shared schemas, a working evidence collection pipeline, a panel-judge architecture, and a comprehensive historical evaluation system. However, the review found **6 critical/high mathematical bugs**, **7 architectural gaps** versus the design specification, **7 robustness issues**, and **5 test coverage gaps**.

The most impactful findings are:

- The disagreement shrinkage formula shrinks the posterior toward probability 0.5 instead of toward the prior, directly undermining forecast accuracy when judges disagree. Additionally, the shrinkage dispersion is computed from `variance(probabilities)` instead of `variance(log_odds_j)` as specified in the design.
- The two-level prior architecture (base-rate + liquidity-adjusted market) is entirely unimplemented. The prior is hardcoded to 0.5.
- The dependency discount formula ignores the computed Jaccard matrix entirely — the Jaccard overlaps are computed and persisted but the actual `dependencyDiscount` used in aggregation is a simple `1 / evidence.length` heuristic.
- The `probability` field in `buildJudgeOpinion` uses a non-Bayesian linear heuristic that biases probability upward with evidence count, and this feeds into the variance calculation for disagreement shrinkage.
- Several core design features are declared in the `VerdictTrace` metadata but not actually implemented: bootstrap uncertainty, calibration mapping, cross-examiner judge, online weight updates, and evidence quality modifiers.

The system is in a functional prototype state for end-to-end flow, but the mathematical core needs significant work before forecast outputs can be trusted for evaluation.

---

## 2. Critical Mathematical Bugs

### 2.1 Disagreement Shrinkage Shrinks Toward Zero, Not Toward the Prior

**Severity:** Critical
**File:** `apps/api/src/modules/judgments/service.ts` — `buildFixtureVerdictTrace`
**Design Reference:** Section 8.5.2

The design document states:

> Shrinkage pulls the posterior toward the prior rather than toward 0.5, preserving prior signal while damping disputed updates.

The current implementation:

```ts
const finalProbability = logOddsToProbability(
  rawPosteriorLogOdds * (1 - disagreementShrinkage)
);
```

This multiplies `rawPosteriorLogOdds` by `(1 - shrinkage)`, which shrinks log-odds toward **0** (probability 0.5), **not** toward the prior log-odds.

**Correct formula per the design:**

```
posterior_log_odds = (1 - shrinkage) * raw_posterior_log_odds + shrinkage * prior_log_odds
```

**Additional issue:** The shrinkage dispersion is computed as `variance(judgeOpinions.map(o => o.probability))` but the design (§8.5.2) specifies `variance(log_odds_j across judges)`. Using probability-space variance instead of log-odds-space variance distorts the shrinkage magnitude, especially for extreme probabilities.

**Note:** The design doc formula at §8.5 line `posterior_log_odds = (1 - shrinkage) * raw_posterior_log_odds` omits the prior term, but the prose at §8.5 and §8.5.2 explicitly states shrinkage pulls toward the prior. The fix follows the prose intent.

**Impact:** When judges disagree, the system falls back to a naive 50/50 instead of falling back to the base-rate/market prior. This means the system discards all prior information under disagreement, which is the opposite of the intended behavior.

**Fix:**

```ts
const priorLogOdds = probabilityToLogOdds(priorProbability);
const disagreementShrinkage = clamp(
  variance(judgeOpinions.map((opinion) => opinion.logBayesFactor)) * 0.25,
  0, 0.6,
);
const posteriorLogOdds =
  (1 - disagreementShrinkage) * rawPosteriorLogOdds +
  disagreementShrinkage * priorLogOdds;
const finalProbability = logOddsToProbability(posteriorLogOdds);
```

### 2.2 Prior Is Always 0.5 — Market Prior Blending Is Unimplemented

**Severity:** Critical
**File:** `apps/api/src/modules/judgments/service.ts` — `buildFixtureVerdictTrace`, `buildInsufficientEvidenceVerdictTrace`
**Design Reference:** Section 8.5, steps 1–2

The design specifies blending a base-rate prior with a liquidity-adjusted market prior:

```
prior_log_odds = alpha * logit(base_rate_prior) + (1 - alpha) * logit(market_prior)
```

In the implementation, `priorProbability` is hardcoded to `0.5`:

```ts
const priorProbability = 0.5;
```

Market data (Polymarket prices) enters only as an evidence item via the `prediction_market` source family, not as a proper prior. This means:

1. There is no two-level prior architecture.
2. Polymarket prices are treated as regular evidence, not as a privileged prior signal.
3. The `alpha` blending parameter is never computed or used.
4. When a reference class has historical data, it is ignored for the prior.

**Impact:** The system cannot leverage its strongest signal (market prices) as a prior, instead treating them as equal-weight evidence alongside web articles and community posts.

### 2.3 Evidence Quality Modifier Is Unimplemented

**Severity:** High
**File:** `apps/api/src/modules/judgments/service.ts` — `buildJudgeOpinion`
**Design Reference:** Section 8.5, step 6

The design specifies an `evidence_quality_j` multiplier bounded in `[0.5, 1.5]` aggregated from per-item quality signals:

```
effective_contribution_j = base_weight_j * dependency_discount_j * evidence_quality_j * freshness_decay_j * log_bayes_factor_j
```

The current implementation:

```ts
const effectiveLogOddsContribution =
  logBayesFactor * baseWeight * dependencyDiscount * freshnessDecay;
```

The `evidence_quality_j` term is missing. Quality signals (official domains, government domains, citation counts, duplicate cluster sizes) are collected in evidence items but never influence the final probability calculation.

**Impact:** High-quality official sources are weighted identically to low-quality blog posts. The quality signal infrastructure is collected but wasted.

### 2.4 Dependency Discount Ignores Computed Jaccard Matrix

**Severity:** High
**File:** `apps/api/src/modules/judgments/service.ts` — `buildJudgeOpinion`, `buildDependencyMatrix`
**Design Reference:** Section 8.5.1

The design specifies:

```
for each judge j:
  overlap_j = sum over k ≠ j of jaccard(evidenceIds_j, evidenceIds_k)
  n_eff_j   = 1 / (1 + overlap_j)
  dependency_discount_j = n_eff_j
```

The Jaccard matrix is correctly computed in `buildDependencyMatrix` and persisted in the trace. However, the actual `dependencyDiscount` used in `buildJudgeOpinion` is:

```ts
const dependencyDiscount = args.evidence.length > 1 ? 1 / args.evidence.length : 1;
```

This is a simple inverse of evidence count, completely unrelated to Jaccard overlap between judges. The matrix is computed *after* opinions are built, so it cannot feed back into the discount. The design's intent — reducing overweighting when judges cite overlapping evidence — is not implemented.

**Impact:** Two judges citing identical evidence each count as full independent votes instead of being discounted to approximately one combined vote.

### 2.5 Judge `probability` Uses a Non-Bayesian Linear Heuristic

**Severity:** High
**File:** `apps/api/src/modules/judgments/service.ts` — `buildJudgeOpinion`
**Design Reference:** Section 8.3.1

The `probability` field in each `JudgeOpinion` is computed as:

```ts
const probability = clamp(
  0.5 + effectiveLogOddsContribution * 0.18 + args.evidence.length * 0.02,
  0.05, 0.95,
);
```

This is a linear heuristic that:
1. Adds `evidence.length * 0.02`, biasing probability upward just for having more evidence regardless of direction.
2. Uses a fixed `0.18` scaling factor that has no mathematical relationship to the log-odds transform.

This probability feeds into `disagreementShrinkage` at line 908 via `variance(judgeOpinions.map(o => o.probability))`, meaning the shrinkage itself is driven by a non-Bayesian heuristic rather than actual posterior probabilities.

**Impact:** The disagreement shrinkage mechanism is based on distorted probability values. A judge with many pieces of weak evidence will appear to agree more with the prior (biased toward higher probability) than it actually does.

### 2.6 Freshness Decay Half-Life Is Hardcoded at 168 Hours

**Severity:** Medium
**File:** `apps/api/src/modules/judgments/service.ts` — `computeFreshnessDecay`
**Design Reference:** Section 8.6

```ts
function computeFreshnessDecay(publishedAt: string, evaluationTime: string): number {
  const ageHours = Math.max(
    0,
    (new Date(evaluationTime).getTime() - new Date(publishedAt).getTime()) / (1000 * 60 * 60),
  );
  return clamp(Math.exp(-ageHours / 168), 0.2, 1);
}
```

The half-life of 168 hours (7 days) is hardcoded. The design says the half-life should be configurable and tunable via calibration. There is no mechanism to:

- Adjust per domain or evidence family.
- Tune via the calibration snapshot.
- Differentiate between fast-moving domains (crypto, elections) and slow-moving ones (regulatory approval).

---

## 3. Architectural Issues and Missing Features vs Design

### 3.1 `service.ts` Is 1,576 Lines and Violates Single Responsibility

**Severity:** High
**File:** `apps/api/src/modules/judgments/service.ts` (1,576 lines)

The file contains all of the following concerns in a single module:

- Judge client interface and HTTP implementation
- Evidence provider factory (`createDefaultEvidenceProviders`)
- Evidence selection and filtering (`selectEvidenceForJudgeInput`, `isEventRelevantEvidence`)
- Bayes factor mapping table and strength-to-score functions
- Log-odds math utilities (`probabilityToLogOdds`, `logOddsToProbability`, `clamp`)
- Panel judge configuration (`PANEL_JUDGES`)
- Citation building and sanitization
- Conflict detection (`buildConflicts`)
- Missing evidence detection (`buildMissingEvidence`)
- Dependency matrix computation (`buildDependencyMatrix`)
- Full judgment orchestration (`runJudgment`)
- Execution logging infrastructure
- Cache store factories (`createEvidenceCacheStore`, `createJudgeCacheStore`)
- Live mode assertions (`assertLiveAuthoritativeSearchProviderConfigured`)

**Recommended decomposition:**

```
modules/judgments/
  service.ts           — orchestration only
  panel.ts             — panel configuration and judge dispatch
  aggregation.ts       — log-odds math, Bayes factor mapping, shrinkage
  evidenceSelection.ts — evidence filtering, relevance, family priority
  traceBuilder.ts      — citation building, conflict detection, missing evidence
  judgeClient.ts       — HTTP client to Python judge service
  cacheFactory.ts      — cache store creation
```

### 3.2 Cross-Examiner Judge Is Unimplemented

**Severity:** High
**Design Reference:** Section 8.3

The design specifies a `cross_examiner` meta-judge that:

- Reads the other judges' opinions
- Flags unsupported leaps, missing corroboration, internal contradictions, and evidence over-reach
- Produces a structured `conflicts` list and per-judge `warnings`
- Does not emit a scalar penalty — the aggregator converts dispersion into a quantitative penalty independently

The `PANEL_JUDGES` array has only 3 evidence-reading judges:

```ts
const PANEL_JUDGES = [
  { judgeName: "official_records", sourceFamilies: ["official", "government"] },
  { judgeName: "community_signal", sourceFamilies: ["community"] },
  { judgeName: "open_web_research", sourceFamilies: ["web", "llm_research", "market", "prediction_market"] },
];
```

Conflicts are generated mechanically from probability gaps (`buildConflicts`), not from LLM cross-examination. This loses the qualitative reasoning about *why* judges disagree.

**Additional issue:** `open_web_research` includes `"market"` and `"prediction_market"` in its `sourceFamilies`. The design explicitly states that market signals should be excluded from judges and routed through the prior step only (Section 8.3: *"Market and prediction-market signals are intentionally excluded from the judge panel"*). Including them as evidence creates double-counting with the (unimplemented) market prior.

### 3.3 Market Prior Is Not Liquidity-Adjusted

**Severity:** High
**Design Reference:** Section 8.6

The design specifies a "Liquidity-adjusted market prior" that converts market prices to log-odds and discounts by spread, depth, and recent volatility. Polymarket evidence enters as raw evidence items with no liquidity/spread adjustment. Thin or manipulated markets receive the same weight as deep, liquid ones.

### 3.4 Online Expert Weight Updates Are Unimplemented

**Severity:** Medium
**File:** `apps/api/src/modules/backtests/repository.ts` — `retrainCalibrationSnapshot`
**Design Reference:** Section 8.5.3

The design specifies exponentially weighted expert updates where judges that repeatedly forecast poorly lose influence. The implementation always creates snapshots with uniform weights:

```ts
const DEFAULT_JUDGE_WEIGHTS = {
  official_records: 1 / 3,
  community_signal: 1 / 3,
  open_web_research: 1 / 3,
};
```

The `onlineLearningParams.enabled` flag exists in the schema but is never used to actually update weights. Even in `steady` regime (100+ resolved outcomes), weights remain uniform.

### 3.5 Bootstrap Uncertainty Bands Are Unimplemented

**Severity:** Medium
**File:** `apps/api/src/modules/judgments/service.ts` — `buildFixtureVerdictTrace`
**Design Reference:** Section 8.6

The design specifies block bootstrap resampling for confidence bands. The implementation uses a simple heuristic:

```ts
const confidenceHalfWidth = noEvidence
  ? 0.15
  : clamp(0.08 + disagreementShrinkage * 0.2, 0.08, 0.2);
```

The `uncertaintyMethod` field is set to `"bootstrap"` in the trace, but no actual bootstrap resampling occurs. This is misleading metadata.

### 3.6 No Calibration Map Is Applied

**Severity:** High
**File:** `apps/api/src/modules/judgments/service.ts`
**Design Reference:** Section 8.7

The design specifies:

> Raw probability is not the final answer. A calibration layer fits historical predicted probabilities against actual outcomes.

The `calibrationMethod` field in the trace can be `"isotonic"`, `"logistic"`, `"beta"`, or `"identity"`, but no actual calibration transform is applied. The `finalProbability` is always the raw pooled probability. Even when the calibration snapshot specifies `method: "isotonic"`, the implementation just returns the uncalibrated value.

### 3.7 No Background Job Queue

**Severity:** Medium
**Design Reference:** Section 6.2

The design mentions Redis-backed job queues. Judgments are currently created and executed synchronously — `runJudgment` runs the full pipeline (evidence collection from 6+ providers + judge service call) in the HTTP request handler. There is:

- No worker process
- No job queue
- No retry logic
- No progress reporting

If the judge service is slow or an evidence provider times out, the HTTP request hangs for the duration. The `workers/` directory exists with scaffolded files (`judgmentWorker.ts`, `watchlistWorker.ts`) but these are thin wrappers around synchronous calls with no queue integration.

---

## 4. Robustness and Correctness Concerns

### 4.1 Transaction Handling Uses Implicit Pool Connections

**Severity:** High
**File:** `apps/api/src/modules/judgments/repository.ts` — `appendJudgmentTrace`

```ts
await pool.query("BEGIN");
// ... operations using pool.query() ...
await pool.query("COMMIT");
```

`pool.query()` acquires an implicit connection from the pool for each call. Different calls may use different connections, breaking the transaction. This should use `pool.connect()` to get an explicit client:

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  // ... operations using client.query() ...
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
```

The evaluation repository (`evaluation/repository.ts`) correctly uses this pattern with `pool.connect()`. The judgment repository should follow suit.

### 4.2 No Timeout on Judge Service HTTP Call

**Severity:** High
**File:** `apps/api/src/modules/judgments/service.ts` — `DefaultJudgeClient.judge`

```ts
const response = await fetch(`${this.env.JUDGE_BASE_URL}/judge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ... }),
});
```

There is no `AbortController` or timeout. If the Python judge service hangs, the API request hangs indefinitely. Evidence providers similarly lack timeouts (the `zaiCli.ts` provider is the only one that implements timeout via `AbortController`).

### 4.3 `InMemoryEvidenceCacheStore.set` Ignores TTL

**Severity:** Low
**File:** `apps/api/src/modules/evidence/cache.ts`

```ts
class InMemoryEvidenceCacheStore implements EvidenceCacheStore {
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}
```

The method signature accepts `ttlSeconds` via the interface but the in-memory implementation ignores it. Items never expire. This is acceptable for tests but should be documented or fixed with a simple TTL mechanism for non-test usage.

### 4.4 Evaluation Replay Runs Sequentially With No Parallelism

**Severity:** Medium
**File:** `apps/api/src/modules/evaluation/replay.ts` — `runHistoricalEvaluation`

The evaluation replay processes all markets, cutoffs, and baselines in nested for-loops with no parallelism:

```
for (market of selectedMarkets)
  for (cutoff of cutoffs)
    for (baseline of baselines)
      await evaluateModelBaseline(...)
```

For a benchmark set of 50 markets, 4 cutoffs, and 4 baselines, this is up to 800 sequential operations. Each model baseline call involves evidence collection (multiple HTTP requests) and a judge call. This could take hours.

**Fix:** Use `Promise.all` with a bounded concurrency limiter (e.g., p-limit) for the market-level loop.

### 4.5 Polymarket Import Fetches All Markets Without Pagination

**Severity:** Medium
**File:** `apps/api/src/modules/evaluation/polymarketImport.ts` — `importResolvedPolymarketBenchmarks`

```ts
const response = await fetchImpl(
  `${args.baseUrl}/markets?closed=true&uma_resolution_status=resolved`,
);
```

No pagination parameters (`offset`, `limit`) are included. If the Polymarket API returns thousands of resolved markets, they are all loaded into memory at once. This could cause memory issues or hit API rate limits.

### 4.6 Evidence Selection Can Under-Represent Diverse Evidence

**Severity:** Low
**File:** `apps/api/src/modules/judgments/service.ts` — `selectEvidenceForJudgeInput`

The `MAX_EVIDENCE_ITEMS_PER_FAMILY` cap of 4 means that if the majority of evidence comes from one family (e.g., many web articles), only 4 are selected. With `MAX_EVIDENCE_ITEMS_FOR_JUDGE` = 12 and 7 source families, the judge could receive as few as 4 items if evidence is concentrated. The family priority ordering (`official > community > web > market`) means low-priority families may be excluded entirely.

### 4.7 `computeBaseRateOnlyProbability` Doesn't Shrink Sparse Classes Toward Global Prior

**Severity:** Medium
**File:** `apps/api/src/modules/evaluation/baselines.ts`

The design specifies empirical-Bayes shrinkage toward a global prior for sparse classes. The implementation:

```ts
if (total < minimumSample) {
  return smoothed;  // Just returns (successes + 1) / (total + 2)
}
return smoothed;
```

Both branches return the same value. When a reference class has only 2 outcomes, the function returns the raw smoothed rate instead of blending it with the global average. The `minimumSample` check is present but has no effect.

---

## 5. Test Coverage Gaps

### 5.1 Numerical Edge Cases in Log-Odds Transforms

**Severity:** High
**File:** `apps/api/test/evaluation-metrics.test.ts` (only 2.7 KB)

No explicit tests for:

- `probabilityToLogOdds(0)` and `probabilityToLogOdds(1)` (boundary clamping)
- Values very close to boundaries (1e-7, 1 - 1e-7)
- `logOddsToProbability` with very large positive and negative log-odds
- `computeFreshnessDecay` when `publishedAt` equals `evaluationTime` (should return 1.0)
- `computeFreshnessDecay` when `publishedAt` is far in the future relative to `evaluationTime`

### 5.2 Metrics Tests Are Insufficient

**Severity:** High
**File:** `apps/api/test/evaluation-metrics.test.ts`

Given that this is the mathematical foundation, the test file is suspiciously small at 2.7 KB. Missing tests:

- Expected Calibration Error (ECE) with non-uniform bin sizes
- Calibration bins with edge probabilities (exactly 0.0, exactly 1.0)
- Win rate when model exactly ties with the reference
- `sliceMetrics` with all baselines and empty groups
- Brier score and log loss with all-same predictions
- `averageAbsoluteError` with mixed outcomes

### 5.3 No Integration Test for Full Evaluation Replay

**Severity:** Medium

The evaluation replay tests (`evaluation-replay.test.ts`, 27 KB) are extensive but there is no test that runs the complete flow from benchmark import through evaluation run to metrics verification with realistic data sizes.

### 5.4 Insufficient Evidence Fallback Path Untested in Replay

**Severity:** Medium

The code path where `liveCoverage.hasEnoughCitationCoverage` is false during replay evaluation is not explicitly tested. This path produces `insufficient_evidence` verdict traces instead of normal ones, and is a critical safety mechanism.

### 5.5 No Tests for Evidence Quality Influence

**Severity:** Medium

Since the evidence quality modifier is unimplemented (see 2.3), there are naturally no tests for it. Once implemented, tests should verify that quality signals in `[0.5, 1.5]` correctly scale judge contributions.

---

## 6. Security and Operational Concerns

### 6.1 No Authentication on Any API Endpoint

**Severity:** Medium (acceptable for prototype, must be addressed before any shared deployment)

Every endpoint is publicly accessible. The `POST /evaluation/runs` endpoint triggers expensive operations (external API calls costing real money, judge service calls). No rate limiting exists. An unauthenticated user could trigger thousands of dollars in API costs.

### 6.2 No Input Sanitization Before External API Calls

**Severity:** Medium

Event questions are passed directly to Perplexity, Z.AI, and other external APIs without sanitization. While these services have their own input handling, maliciously crafted questions could:

- Abuse downstream API rate limits
- Inject prompt-like content into LLM-backed search providers
- Trigger unexpectedly large responses

### 6.3 No Cleanup Mechanism for Historical Data

**Severity:** Low

Evidence items, judgment traces, execution logs, and evaluation data persist forever. There is no archival or cleanup mechanism. Over time, the database will grow unbounded. For a research prototype this is acceptable, but it should be planned for.

### 6.4 Verdict Trace Contains Model Version Strings

**Severity:** Low

`buildJudgeModelVersion` concatenates environment variables including API keys structure:

```ts
function buildJudgeModelVersion(env: AppEnv): string {
  return [
    env.CASSANDRA_ADAPTER_MODE,
    env.OPENROUTER_JUDGE_MODEL ?? "default-judge",
    env.OPENROUTER_CROSS_EXAMINER_MODEL ?? "default-cross",
    env.OPENROUTER_SEARCH_MODEL ?? "default-search",
    env.ZAI_MODEL ?? "default-zai",
  ].join("|");
}
```

While it doesn't leak actual keys, it reveals model names and configuration. If verdict traces are ever exposed to untrusted parties, this could aid in adversarial manipulation of the system.

---

## 7. Design Alignment Matrix

| Design Spec Feature | Status | Notes |
|---|---|---|
| Reference-class base-rate prior | **Partial** | Schema supports it; no shrinkage to global prior for sparse classes |
| Liquidity-adjusted market prior | **Unimplemented** | Market prices enter as evidence only |
| Bayesian updating in log-odds | **Implemented** | Correct log-odds space math |
| Panel of specialized judges | **Implemented** | 3 judges; missing cross-examiner |
| Cross-examiner meta-judge | **Unimplemented** | Conflicts generated mechanically |
| Log-opinion pool aggregation | **Buggy** | Shrinkage toward 0.5 instead of prior; dispersion uses probability variance instead of log-odds variance |
| Evidence quality modifier | **Unimplemented** | Quality signals collected but unused |
| Dependency discount (Jaccard) | **Buggy** | Jaccard matrix computed but not used for actual discounting; discount is `1/evidence.length` |
| Freshness decay | **Implemented** | Hardcoded 7-day half-life |
| Online expert weight updates | **Unimplemented** | Weights always uniform |
| Isotonic/logistic calibration | **Unimplemented** | `calibrationMethod` set but no transform applied |
| Bootstrap confidence bands | **Unimplemented** | Heuristic formula; `uncertaintyMethod` says "bootstrap" |
| Evidence caching | **Implemented** | Redis + in-memory with hour-bucket keys |
| Judge output caching | **Implemented** | With fingerprint-based cache keys |
| Historical replay evaluation | **Implemented** | 4 horizons, 4 baselines |
| 4-baseline comparison | **Implemented** | With Polymarket leakage protection |
| Leakage controls | **Implemented** | `assertNoPolymarketLeak`, cutoff filtering |
| Brier score, log loss | **Implemented** | Core metrics functional |
| Expected calibration error | **Implemented** | With configurable bins |
| Win rate vs Polymarket | **Implemented** | Reference-based comparison |
| Slice metrics (theme, horizon) | **Implemented** | Grouped metrics by slice key |
| Background job queue | **Unimplemented** | Synchronous execution |
| OpenAPI/Swagger documentation | **Unimplemented** | Manual API reference only |

---

## 8. Priority Recommendations

### Tier 1 — Fix Before Next Evaluation Run

1. **Fix disagreement shrinkage** to shrink toward the prior, not toward 0.5. Also fix the dispersion input to use `variance(logBayesFactor)` instead of `variance(probability)`.
2. **Fix the dependency discount** to use the Jaccard-based formula from the design instead of `1 / evidence.length`. This requires restructuring so the dependency matrix is computed before opinions use it.
3. **Fix the judge `probability` heuristic** — replace the linear formula with `logOddsToProbability(logBayesFactor)` so it represents an actual posterior probability.
4. **Fix the transaction handling** in `appendJudgmentTrace` to use an explicit client connection (pattern already exists in evaluation repository).
5. **Add timeout/abort** to the judge service HTTP call and all evidence provider fetch calls.

### Tier 2 — Fix Before Trusting Forecast Accuracy

6. **Implement market prior blending** so Polymarket prices serve as a proper prior rather than just evidence.
7. **Decompose `service.ts`** into focused modules (aggregation math, panel config, evidence selection, orchestration).
8. **Implement at least logistic calibration** before claiming any calibration method other than `identity` in the trace.
9. **Implement the cross-examiner** or explicitly remove it from the design and replace with the mechanical conflict detection already in place.
10. **Implement evidence quality modifiers** so collected quality signals actually influence forecasts.
11. **Expand metrics tests** significantly — the mathematical core must have exhaustive edge-case coverage.

### Tier 3 — Fix for Production Readiness

12. **Remove market/prediction_market from `open_web_research` sourceFamilies** to prevent double-counting.
13. **Implement online weight updates** for the `warming` and `steady` regimes.
14. **Add pagination** to the Polymarket benchmark import.
15. **Add parallelism** to evaluation replay (bounded concurrency for market-level processing).
16. **Add authentication** or at minimum rate limiting on expensive endpoints.
17. **Implement a background job queue** using Redis (the `workers/` directory is already scaffolded).

---

## 9. Detailed Findings

### 9.1 File-by-File Analysis

#### `apps/api/src/modules/judgments/service.ts` (1,576 lines)

This is the largest and most complex file in the codebase. It contains the complete judgment pipeline from evidence selection through aggregation to trace construction.

**Positive aspects:**
- Well-structured judge panel configuration with clear source family assignments
- Thorough evidence relevance filtering with token-based overlap detection
- Proper evidence deduplication and family-priority sorting
- Comprehensive execution logging at each pipeline stage
- Clean cache integration for both evidence and judge outputs

**Issues beyond those already listed:**
- `buildDependencyMatrix` computes Jaccard for all judge pairs, but the result is only used for `weightBreakdown` display — it doesn't feed back into the `dependencyDiscount` calculation (see §2.4).
- The `PROMPT_VERSION` constant is `"prompt-v1"` but is included in cache keys without any mechanism to update it when prompts change.
- `isPlaceholderCitationUrl` checks for `example.invalid` and `openrouter.ai/synthetic`, but there is no systematic way to ensure all fixture providers use these URL patterns.

#### `apps/api/src/modules/evaluation/replay.ts` (500+ lines)

**Positive aspects:**
- Well-structured baseline separation with proper Polymarket leakage guards
- Shared evidence store prevents redundant API calls across baselines for the same event/cutoff
- Replay fidelity tracking (exact vs approximate) is correctly implemented
- Proper cutoff-based evidence filtering

**Issues:**
- `collectReplayEvidence` has a code path for `fixture` mode that bypasses the shared evidence store, meaning fixture-mode evaluations don't benefit from evidence sharing across baselines.
- `inferReplayEntities` uses a fragile regex to extract entities from market questions. It will fail on many question formats (e.g., questions not starting with "Will").
- The fallback calibration snapshot (`createFallbackCalibrationSnapshot`) sets `weightRegime: "cold_start"` and `calibrationParams.method: "identity"`, which is correct, but it never checks if a snapshot exists in the database before creating the fallback.

#### `apps/api/src/modules/evaluation/metrics.ts` (100+ lines)

**Positive aspects:**
- Clean, functional implementation of standard scoring rules
- Brier score, log loss, and MAE are correctly implemented
- Calibration bins handle edge cases (empty inputs, uneven distributions)

**Issues:**
- `calibrationBins` uses `Math.floor(predicted * bins)` which can put `predicted = 1.0` into the last bin via `Math.min(..., bins - 1)`, but this means the top bin has a slightly different range interpretation.
- `winRateVsReference` counts strict wins only (`ourError < referenceError`). Ties are not counted as wins, which is a conservative choice but may underrepresent performance.

#### `apps/api/src/modules/evaluation/baselines.ts` (100+ lines)

**Positive aspects:**
- Clean Polymarket leakage detection and assertion
- Proper snapshot selection at cutoff with time-based filtering
- Base-rate computation with Laplace smoothing

**Issues:**
- `computeBaseRateOnlyProbability` has a dead code path (see 4.7)
- `providersForBaseline` filters out Polymarket providers by name (`"polymarketGamma"`, `"polymarketClob"`), but this relies on provider naming convention rather than a more robust mechanism like the provider's source family.

#### `apps/api/src/modules/evaluation/polymarketImport.ts` (200+ lines)

**Positive aspects:**
- Robust normalization of Polymarket's varied API response formats
- Handles multiple field name conventions (camelCase and snake_case)
- Proper filtering of non-binary markets and unresolved markets

**Issues:**
- No pagination (see 4.5)
- `normalizeResolvedValue` determines resolution from outcome prices at import time, but this may not match the actual resolution if the prices were captured before final settlement
- `normalizeResolvedValue` determines resolution from outcome prices at import time, but this may not match the actual resolution if the prices were captured before final settlement

#### `apps/api/src/modules/evidence/cache.ts` (150+ lines)

**Positive aspects:**
- Clean cache store abstraction with Redis and in-memory implementations
- Hour-bucket cache key design prevents stale cross-hour results
- Proper error handling that degrades gracefully when individual providers fail
- All-providers-failed guard for live mode

**Issues:**
- In-memory store ignores TTL (see 4.3)
- The all-providers-failed error message includes raw error details from each provider, which could leak internal implementation details

#### `apps/api/src/modules/evidence/normalize.ts` (150+ lines)

**Positive aspects:**
- URL canonicalization strips tracking parameters
- Fuzzy title deduplication catches near-identical articles
- Entity and claim merging preserves unique values across duplicates

**Issues:**
- `fuzzyTitleKey` normalizes aggressively (lowercase, strip non-alphanumeric), which could merge unrelated articles with similar titles (e.g., "Apple revenue up" and "Apple revenue down" would have the same key if only "apple" and "revenue" survive the 3-char minimum filter — actually these differ, but "Apple 2024 revenue" and "Apple 2025 revenue" would collide).
- `mergeEvidenceItems` always keeps the longer summary and raw text, which may not be the higher-quality option.

### 9.2 Schema vs Implementation Consistency

The shared schemas in `packages/shared/src/schemas.ts` are well-defined and comprehensive. However, several fields in the schemas represent capabilities that aren't implemented:

- `CalibrationMethodSchema` includes `"isotonic"`, `"logistic"`, `"beta"` — only `"identity"` is effectively used
- `UncertaintyMethodSchema` includes `"bootstrap"` — only a heuristic is used
- `WeightRegimeSchema` includes `"warming"` and `"steady"` — but neither changes actual behavior (weights remain uniform)
- `CalibrationSnapshotSchema.onlineLearningParams` — the `enabled` field is set but never checked

These schema-implementation gaps are misleading because the `VerdictTrace` metadata claims capabilities that don't exist.

### 9.3 Provider Implementation Quality

| Provider | Fixture Support | Live Mode | Timeout | Error Handling |
|---|---|---|---|---|
| Z.AI Web Search | No | Yes | Yes (60s) | Yes |
| Perplexity | Yes (file) | Yes | No | No |
| Polymarket Gamma | Yes (file) | Yes | No | Partial (slug fallback) |
| Polymarket CLOB | Yes (file) | Yes | No | Partial (404 handling) |
| Official Search | Yes (file) | Yes | No | No |
| Government Search | Yes (file) | Yes | No | No |
| Community Search | Yes (file) | Yes | No | No |
| Web Provider | Yes (file) | Yes | No | No |
| Custom Market | Yes (file) | Yes | No | No |

Only the Z.AI provider implements proper timeout handling. All other providers will hang indefinitely if the upstream service is unresponsive.

---

*End of review*
