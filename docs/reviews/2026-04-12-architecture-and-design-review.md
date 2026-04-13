# Architecture and Design Review

**Date:** 2026-04-12
**Project:** Cassandra Forecasting System
**Reviewer:** Gemini CLI Agent

---

## 1. Architectural Criticisms

### 1.1 Brittle Asynchronous Execution (Reliability Gap)
The current implementation of asynchronous judgment runs is fundamentally brittle.
- **Problem:** `POST /judgments` triggers the judgment process using `setTimeout(..., 0)`.
- **Impact:** This is an in-memory timer. If the API process restarts or crashes during a run, the judgment is lost. There is no persistence, no retry logic, and no way to track progress across restarts.
- **Suggestion:** Fully migrate to the included **BullMQ** infrastructure. Every judgment run should be a durable job in Redis, allowing for worker isolation, retries, and status monitoring.

### 1.2 "God File" Monoliths (Maintainability Gap)
The codebase has two major points of congestion that pose high risk for future development.
- **Problem:**
    - `apps/api/src/modules/judgments/service.ts` (~1,800 lines): Handles DB I/O, evidence filtering, judge panel orchestration, and mathematical aggregation.
    - `apps/web/src/App.tsx` (~2,500 lines): Contains the entire routing, state, and UI logic for the frontend.
- **Impact:** These files are nearly impossible to unit test without triggering massive side effects. They create high cognitive load for developers and high risk of regressions.
- **Suggestion:** 
    - **API:** Decompose into `aggregation.ts` (pure functions), `selection.ts` (evidence logic), and `panel.ts` (judge client orchestration).
    - **Web:** Refactor into a standard component-based structure (`/pages`, `/components`, `/api`).

### 1.3 Logic Drift Between Modes (Consistency Gap)
The system currently maintains two parallel "Brains."
- **Problem:** The TypeScript `fixture` mode and the Python `live` mode have drifted. The TS code implements a simplified version of the logic (missing features like the Cross-Examiner) to support local development.
- **Impact:** Testing in `fixture` mode does not validate the actual mathematical behavior of the system. It creates a false sense of security.
- **Suggestion:** The TypeScript API should be a **Pure Orchestrator**. Even in `fixture` mode, it should call the Python Judge Service. The Python service should be the one to handle "fixture" data if requested, ensuring the mathematical core is identical across all environments.

---

## 2. Design Gaps & Missings

### 2.1 "Dead" Design Features (Zombie Code)
Several core features promised in the design documents are present in schemas but unimplemented in the logic:
- **Calibration Transforms:** The system reports `calibrationMethod` (e.g., "isotonic"), but the code only supports `identity`.
- **Bootstrap Uncertainty:** The trace metadata says "bootstrap," but the code uses a hardcoded heuristic (`+ 0.15`).
- **Online Learning:** Expert weight updates are defined in the `CalibrationSnapshot` but never applied to the judgment weights (which remain 1/3 each).

### 2.2 Implicit Transaction Risks
The judgment repository uses implicit pool connections for transactions (`pool.query("BEGIN")`).
- **Impact:** In a high-concurrency environment, `pool.query` can pick up a different connection for each call, potentially breaking the transaction scope.
- **Fix:** Use explicit clients (`const client = await pool.connect()`) as seen in the evaluation repository.

### 2.3 Evidence Quality signals (Collected but Wasted)
The evidence normalization layer collects rich signals (official domain, government domain, citation counts), but these are **never used** in the Python or TS aggregation logic. They are currently "dead data."

---

## 3. Recommended Improvements

### 3.1 Strategic: "The Single Source of Truth"
Move **all** logic that touches the `VerdictTrace` (aggregation, shrinkage, dependency discounting) into the Python service. Treat the Python service as a stateless "Forecasting Brain" and the TypeScript API as the "Evidence and Storage Muscle."

### 3.2 Security & Operations
- **API Authentication:** Add simple API Key validation. The current system allows unauthenticated users to trigger high-cost LLM calls.
- **HTTP Timeouts:** Add `AbortController` to all `fetch` calls. The system currently hangs indefinitely if an upstream provider (Perplexity, OpenRouter) is slow.
- **Incremental Migrations:** Replace the `db-migrate.sh` (which reapplies the full schema) with an incremental migration tool like `node-pg-migrate`.

---

## 4. Implementation Priorities (Tiered)

1.  **Tier 1 (Reliability/Math):** Job Queue migration, HTTP timeouts, and fix the "Shrinkage to Zero" math bug.
2.  **Tier 2 (Architecture):** Refactor `service.ts` and `App.tsx`; harmonize `fixture` mode.
3.  **Tier 3 (Features):** Implement actual Calibration transforms and evidence quality modifiers.
