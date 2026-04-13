# Architectural Improvements Design

**Date:** 2026-04-12
**Status:** PROPOSED
**Codename:** Cassandra Phase 2 (Hardening)

---

## 1. Objective
To transition the Cassandra prototype from a "happy-path" research script into a durable, maintainable, and mathematically consistent forecasting system. This design addresses the three primary architectural risks identified in the Phase 1 audit: non-durable execution, logic drift, and extreme technical debt.

---

## 2. Core Transitions

### 2.1 From Memory Timers to Durable Queues
Currently, the system uses `setTimeout(..., 0)` to handle long-running judgments. This is being replaced with a **BullMQ** (Redis-backed) architecture.

**The New Flow:**
1.  **Ingestion:** `POST /judgments` validates the input and creates a `Judgment` record in Postgres with status `queued`.
2.  **Enqueuing:** The API adds a job to the `judgment-queue` in Redis.
3.  **Execution:** A dedicated `judgmentWorker.ts` picks up the job.
4.  **Resilience:** If the worker crashes, BullMQ automatically retries the job (up to 3 times) based on a backoff strategy.
5.  **Observability:** The `Runtime` page in the UI will now reflect real-time queue states (Active, Completed, Failed, Waiting).

### 2.2 From "Split Brain" to "Stateless Brain"
Currently, both TypeScript and Python implement versions of the aggregation math. We will move to a **Pure Orchestrator / Stateless Brain** model.

- **TypeScript API (The Muscle):** Handles all I/O. It collects evidence from providers, stores it in Postgres, and passes the **entire evidence set** to the Python service. It does not perform any Bayes-factor or shrinkage math.
- **Python Service (The Brain):** Acts as a pure inference engine. It takes an event and a list of evidence items and returns a complete `VerdictTrace`.
- **Fixture Mode Harmonization:** In `fixture` mode, the TypeScript API still calls the Python Service. The Python service is responsible for loading its own fixtures or mocking LLM calls, ensuring the mathematical core is 100% identical in local and production environments.

### 2.3 Decomposing the "God Files"
We will break down the ~2,000+ line files into focused, testable modules.

**Refactoring `apps/api/src/modules/judgments/service.ts`:**
- `panel.ts`: Defines the judges and their assigned source families.
- `selection.ts`: Logic for filtering and prioritizing evidence items before sending to the judge.
- `orchestration.ts`: The high-level workflow (Load Event -> Collect Evidence -> Call Judge Service -> Persist Trace).
- `judgeClient.ts`: Clean HTTP client for the Python service with `AbortController` timeouts.

**Refactoring `apps/web/src/App.tsx`:**
- Move to a directory structure:
    - `/src/components/judgments/`: `VerdictTraceView`, `JudgeCard`, `EvidenceTimeline`.
    - `/src/pages/`: `EventsPage`, `JudgmentDetailPage`, `EvaluationPage`.
    - `/src/hooks/`: `useJudgmentPolling`, `useEvaluationStats`.

---

## 3. Mathematical Integrity Fixes

### 3.1 Prior-Relative Shrinkage
We will replace the current shrinkage formula in Python to pull the posterior back to the **actual prior** (Base Rate + Market) instead of the 50/50 midpoint.
```python
# The corrected aggregation logic
posterior_log_odds = (1 - shrinkage) * raw_posterior_log_odds + shrinkage * prior_log_odds
```

### 3.2 Automated Dependency Discounting
The TypeScript orchestrator will now compute the Jaccard overlap matrix **before** calling the judge client and will pass the resulting `dependencyDiscount` values into the Python request, ensuring they are used in the final aggregation sum.

---

## 4. Operational Hardening

### 4.1 Explicit Transaction Management
All repository methods that perform multiple writes (like `appendJudgmentTrace`) will be refactored to use explicit client connections:
```typescript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // ... writes ...
  await client.query('COMMIT');
} finally {
  client.release();
}
```

### 4.2 API Security
A new middleware will be added to `apps/api/src/app.ts` to validate a `X-API-KEY` header against an environment-defined secret. This prevents unauthorized access to the LLM judging pipeline.

---

## 5. Success Metrics
1.  **Durable Recovery:** A judgment interrupted by a server restart resumes and completes successfully.
2.  **Mathematical Parity:** Identical input in `fixture` and `live` modes yields identical `VerdictTrace` structures.
3.  **Auditability:** Every trace clearly shows the `dependencyDiscount` and `shrinkage` scalars applied.
4.  **Developer Velocity:** New developers can understand the aggregation logic by reading a single <200 line Python file instead of an 1,800 line TS file.
