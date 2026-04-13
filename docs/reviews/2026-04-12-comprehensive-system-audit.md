# Comprehensive System Audit & Remediation Plan

**Date:** 2026-04-12
**Status:** CRITICAL ISSUES IDENTIFIED
**Scope:** Architecture, Mathematical Integrity, Robustness, and Design Alignment

---

## 1. Executive Summary

A deep-dive audit of the Cassandra forecasting prototype has revealed significant deviations from the design specification, critical mathematical bugs in the scoring engine, and architectural risks in the orchestration layer. While the system is functional as a prototype, the current "completed" judgments are mathematically flawed, and the infrastructure lacks the durability required for reliable research operations.

**Key Findings:**
- **Mathematical Integrity:** Both the Python and TypeScript implementations contain bugs in the posterior aggregation (shrinkage and dependency discounting) that undermine forecast accuracy.
- **Architectural Debt:** Oversized "God Files" in both API and Web packages (~2,000+ lines each) make the codebase difficult to maintain and audit.
- **Robustness Gaps:** Asynchronous tasks use non-durable memory timers (`setTimeout`) instead of the included `BullMQ` infrastructure, and critical HTTP calls lack timeouts.
- **Mode Inconsistency:** The TypeScript `fixture` mode and Python `live` mode have drifted, with the TypeScript side missing core features like the Cross-Examiner judge.

---

## 2. Critical Technical Findings

### 2.1 Mathematical Bugs (Tier 1)

#### A. Disagreement Shrinkage (Python & TS)
- **Issue:** In `services/judge/app/scoring/aggregate.py`, the formula `(1 - shrinkage) * raw_posterior_log_odds` shrinks the posterior toward **0.5 (log-odds 0)** instead of toward the **prior**.
- **Impact:** Under high judge disagreement, the system defaults to 50/50, discarding valuable base-rate or market prior information.
- **Correction Required:** `posterior_log_odds = (1 - shrinkage) * raw_posterior_log_odds + shrinkage * prior_log_odds`.

#### B. Missing Dependency Discount (TypeScript)
- **Issue:** `apps/api/src/modules/judgments/service.ts` computes the Jaccard overlap matrix but fails to pass the `dependencyDiscount` parameter to the `buildJudgeOpinion` function calls.
- **Impact:** Judges are always treated as 100% independent, leading to massive over-weighting when multiple judges cite the same evidence.

#### C. Judge Probability Heuristic
- **Issue:** Judge "probability" fields are often derived from linear heuristics rather than actual log-odds transforms, distorting the input to the variance-based shrinkage calculation.

### 2.2 Architectural & Robustness Risks (Tier 1)

#### A. Non-Durable Workers
- **Issue:** `POST /judgments` enqueues runs using `setTimeout(..., 0)`.
- **Impact:** If the API process restarts, all "queued" or "running" judgments are lost permanently. The project includes `BullMQ` but does not use it for judgment orchestration.

#### B. Missing HTTP Timeouts
- **Issue:** Calls to `fetch()` for the Judge Service and Search Providers (Perplexity, etc.) lack `AbortController` timeouts.
- **Impact:** A single slow upstream dependency can hang an API worker indefinitely, leading to resource exhaustion.

#### C. Massive File Debt
- **Issue:** `apps/api/src/modules/judgments/service.ts` (~1,800 lines) and `apps/web/src/App.tsx` (~2,500 lines) are "God Files."
- **Impact:** Extremely high cognitive load for reviewers and high risk of regression during refactoring.

---

## 3. Remediation & Implementation Plan

### Tier 1: Immediate Correctness (Next 24 Hours)

| Task | Description | File(s) |
|---|---|---|
| **T1.1** | Fix Python shrinkage math to pull toward the prior. | `services/judge/app/scoring/aggregate.py` |
| **T1.2** | Fix TS `dependencyDiscount` omission in `service.ts`. | `apps/api/src/modules/judgments/service.ts` |
| **T1.3** | Implement `AbortController` timeouts (default 30s) for all `fetch` calls. | `apps/api/src/modules/judgments/service.ts`, `apps/api/src/modules/evidence/providers/*` |
| **T1.4** | Fix repository transaction handling to use explicit client connections. | `apps/api/src/modules/judgments/repository.ts` |
| **T1.5** | Delete redundant/duplicate files (e.g., `polymarketImport 2.ts`). | `apps/api/src/modules/evaluation/` |

### Tier 2: Structural Integrity (Next 3 Days)

| Task | Description | File(s) |
|---|---|---|
| **T2.1** | Migrate `setTimeout` workers to `BullMQ` + `Redis`. | `apps/api/src/workers/`, `apps/api/src/modules/judgments/routes.ts` |
| **T2.2** | Decompose `judgments/service.ts` into `aggregation.ts`, `panel.ts`, and `selection.ts`. | `apps/api/src/modules/judgments/` |
| **T2.3** | Implement basic API Key authentication for POST/PUT endpoints. | `apps/api/src/app.ts` |
| **T2.4** | Harmonize `fixture` mode to include the Cross-Examiner (mechanical fallback). | `apps/api/src/modules/judgments/service.ts` |

### Tier 3: Feature Alignment (Next 7 Days)

| Task | Description | File(s) |
|---|---|---|
| **T3.1** | Implement Logistic/Isotonic calibration transforms (beyond `identity`). | `services/judge/app/scoring/calibration.py` |
| **T3.2** | Refactor `App.tsx` into a routed component directory structure. | `apps/web/src/` |
| **T3.3** | Add bounded parallelism to the Evaluation Replay runner. | `apps/api/src/modules/evaluation/replay.ts` |
| **T3.4** | Implement online expert weight updates in `warming` regime. | `services/judge/app/scoring/weights.py` |

---

## 4. Acceptance Criteria for Remediation

1. **Math Check:** A judgment with 100% judge disagreement must yield a `finalProbability` equal to the `priorProbability`.
2. **Dependency Check:** Two judges citing the same evidence must show a `dependencyDiscount` of `~0.5` in the persisted trace.
3. **Durability Check:** Killing and restarting the API process during a judgment run must result in the run resuming (via BullMQ/Redis).
4. **Maintenance Check:** No single TypeScript file should exceed 500 lines of code.
