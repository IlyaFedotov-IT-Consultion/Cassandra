# Multi-Source Forecast Judge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local-Docker research prototype that ingests multi-source evidence, produces traceable probability judgments for events, and supports watchlists plus backtesting.

**Architecture:** Use a `pnpm` workspace for the TypeScript API, shared package, and React UI, plus a Python FastAPI service for the mathematical judge. Persist all durable records in Postgres, use Redis for queues, and connect the API to the judge service over HTTP with shared JSON schemas.

**Tech Stack:** pnpm, TypeScript, Fastify, React, Vite, Vitest, PostgreSQL, Redis, BullMQ, Python, FastAPI, Pydantic, NumPy, scikit-learn, Docker Compose, Playwright

---

## Mathematical Foundations To Implement

The judging core is not a generic score blender. The implementation must explicitly include:

- reference-class forecasting through empirical-Bayes base-rate priors, with explicit `referenceClass` tagging per design §8.4 (no automatic class discovery in v1)
- liquidity-adjusted market and prediction-market priors (prior-only; markets never enter the judge panel — design §8.3)
- Bayesian evidence updates expressed as bounded log Bayes factors mapped from a Likert `evidenceStrength` ordinal (design §8.3.1)
- Jaccard-based dependency discount computed by the aggregator from judge `evidenceIds` overlap (design §8.5.1)
- variance-based disagreement shrinkage toward the prior instead of a cross-examiner penalty scalar (design §8.5.2)
- cold-start regimes (`cold_start` → `warming` → `steady`) switching weights and calibration by resolved-outcome count (design §8.5.3)
- regularized logarithmic opinion pooling in log-odds space
- proper scoring rules: Brier score and log score
- online expert reweighting with exponentially weighted updates (warming/steady regimes only)
- isotonic calibration with logistic fallback (steady regime); logistic/beta in warming; identity in cold_start
- bootstrap-based uncertainty estimation over evidence clusters and judge subsets

## Target File Layout

```text
.
|-- .env.example
|-- README.md
|-- docker-compose.yml
|-- package.json
|-- pnpm-workspace.yaml
|-- tsconfig.base.json
|-- apps/
|   |-- api/
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   |-- vitest.config.ts
|   |   |-- src/
|   |   |   |-- index.ts
|   |   |   |-- app.ts
|   |   |   |-- config/env.ts
|   |   |   |-- lib/db.ts
|   |   |   |-- lib/queue.ts
|   |   |   |-- modules/
|   |   |   |   |-- events/
|   |   |   |   |-- watchlists/
|   |   |   |   |-- judgments/
|   |   |   |   |-- outcomes/
|   |   |   |   |-- backtests/
|   |   |   |   |-- evaluation/
|   |   |   |   `-- evidence/
|   |   |   `-- workers/
|   |   `-- test/
|   `-- web/
|       |-- package.json
|       |-- vite.config.ts
|       `-- src/
|           |-- main.tsx
|           |-- App.tsx
|           |-- api/client.ts
|           |-- pages/
|           `-- components/
|-- packages/
|   `-- shared/
|       |-- package.json
|       |-- tsconfig.json
|       `-- src/
|           |-- index.ts
|           `-- schemas.ts
`-- services/
    `-- judge/
        |-- pyproject.toml
        |-- app/
        |   |-- main.py
        |   |-- models.py
        |   |-- api.py
        |   `-- scoring/
        |       |-- priors.py
        |       |-- aggregate.py
        |       |-- calibration.py
        |       |-- uncertainty.py
        |       |-- weights.py
        |       `-- judges/
        `-- tests/
```

## Task 1: Scaffold the monorepo and local runtime

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `README.md`
- Create: `scripts/db-migrate.sh`

**Step 1: Create the workspace root files**

Write root files defining:

- workspace packages: `apps/*`, `packages/*`
- common TypeScript compiler settings
- root scripts: `dev`, `build`, `test`, `lint`, `db:migrate`
- service environment variables, including `CASSANDRA_ADAPTER_MODE` (default `live`, supported `live|fixture`)
- Docker services for `postgres`, `redis`, `api`, `judge`, and `web`
- `scripts/db-migrate.sh` that runs `psql "$DATABASE_URL" -f apps/api/src/db/schema.sql` so the schema can be applied to a cold Postgres container before tests. Wired into `pretest` on the API package in Task 4.

Document `CASSANDRA_ADAPTER_MODE=fixture` in `.env.example` as the default mode for local iteration without external API keys. Live mode is only required for real judgments and historical replay.

**Step 2: Verify the workspace metadata parses**

Run:

```bash
pnpm install
```

Expected:

- lockfile created
- no package-resolution errors

**Step 3: Start infrastructure only**

Run:

```bash
docker compose up -d postgres redis
```

Expected:

- Postgres and Redis containers become healthy

**Step 4: Commit scaffold**

Run:

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .env.example docker-compose.yml README.md
git commit -m "chore: scaffold workspace and local runtime"
```

## Task 2: Create the shared schema package

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/schemas.ts`
- Create: `packages/shared/scripts/export-json-schema.ts`
- Test: `packages/shared/src/schemas.ts`

**Step 1: Define the canonical schemas**

Implement Zod schemas and exported types for:

- `EventInput` (includes nullable `referenceClass` from the v1 taxonomy in design §8.4)
- `WatchlistInput`
- `CandidateEvent`
- `EvidenceItem` (persists `publishedAt` verbatim; no `freshnessHours` field — freshness is derived at aggregation time, see design §7.2)
- `JudgeOpinion` (split into judge-produced fields and aggregator-derived fields, per design §9.1)
- `VerdictTrace`
- `OutcomeInput`
- `CalibrationSnapshot`
- `BenchmarkMarket`
- `EvaluationRun`
- `EvaluationSliceResult`

Use exact enum values for source families, judgment statuses, `evidenceStrength` Likert levels (`strong_against`…`strong_for`), and `weightRegime` (`cold_start|warming|steady`) so API and UI cannot drift.

Ensure the mathematical trace fields are part of the schema from day one:

- `JudgeOpinion.evidenceStrength` (Likert ordinal, judge-produced)
- `JudgeOpinion.logBayesFactor` (aggregator-derived via §8.3.1 table)
- `JudgeOpinion.baseWeight` (from calibration snapshot)
- `JudgeOpinion.dependencyDiscount` (aggregator-computed from Jaccard of `evidenceIds`)
- `JudgeOpinion.freshnessDecay`
- `JudgeOpinion.effectiveLogOddsContribution`
- `VerdictTrace.evaluationTime`
- `VerdictTrace.referenceClass` / `VerdictTrace.referenceClassFallback`
- `VerdictTrace.priorProbability`
- `VerdictTrace.rawPosteriorProbability`
- `VerdictTrace.dependencyMatrix`
- `VerdictTrace.disagreementShrinkage`
- `VerdictTrace.ensembleMethod`
- `VerdictTrace.calibrationMethod`
- `VerdictTrace.uncertaintyMethod`
- `VerdictTrace.weightRegime`
- `VerdictTrace.replayFidelity`
- `VerdictTrace.conflicts` as `Array<{ judgeA: string, judgeB: string, reason: string, severity: "low"|"medium"|"high" }>`
- `VerdictTrace.missingEvidence` as `Array<{ claim: string, sourceFamily: string, reason: string }>`
- `CalibrationSnapshot.baseRateParams`
- `CalibrationSnapshot.marketPriorParams`
- `CalibrationSnapshot.onlineLearningParams`
- `CalibrationSnapshot.weightRegime`
- `CalibrationSnapshot.resolvedOutcomeCount` (the `N` that drives the regime)

**Step 2: Add representative schema tests**

Create tests or inline assertions validating:

- valid event input parses, including a known `referenceClass` and a null fallback
- invalid source family rejects
- verdict trace requires judge opinions and citations
- `evidenceStrength` enum rejects out-of-range strings
- `weightRegime` enum is respected

**Step 3: Export JSON Schema for downstream consumers**

Add `packages/shared/scripts/export-json-schema.ts` that uses `zod-to-json-schema` to emit `packages/shared/dist/schemas.json` during the package build. This file is the source of truth consumed by the Python judge service in Task 8 (via `datamodel-code-generator`) so Zod and Pydantic cannot silently drift.

**Step 4: Verify the package builds**

Run:

```bash
pnpm --filter @cassandra/shared build
```

Expected:

- TypeScript compilation succeeds
- `packages/shared/dist/schemas.json` is produced

**Step 5: Commit shared schemas**

Run:

```bash
git add packages/shared
git commit -m "feat: add shared schemas for forecast judge"
```

## Task 3: Build the API service skeleton

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/config/env.ts`
- Create: `apps/api/src/lib/db.ts`
- Create: `apps/api/src/lib/queue.ts`
- Create: `apps/api/test/health.test.ts`

**Step 1: Create the Fastify app skeleton**

Implement:

- `buildApp()` in `src/app.ts`
- startup in `src/index.ts`
- env validation in `src/config/env.ts`
- Postgres connection helper in `src/lib/db.ts`
- BullMQ connection helper in `src/lib/queue.ts`

**Step 2: Add base routes**

Expose:

- `GET /health`
- `GET /ready`

`/ready` should check Postgres and Redis connectivity.

**Step 3: Write a smoke test**

Implement `apps/api/test/health.test.ts` to assert the app returns `200` for `/health`.

**Step 4: Run the API tests**

Run:

```bash
pnpm --filter @cassandra/api test
```

Expected:

- health route test passes

**Step 5: Commit API skeleton**

Run:

```bash
git add apps/api
git commit -m "feat: scaffold api service"
```

## Task 4: Add database schema and repositories

**Files:**
- Create: `apps/api/src/modules/events/repository.ts`
- Create: `apps/api/src/modules/watchlists/repository.ts`
- Create: `apps/api/src/modules/judgments/repository.ts`
- Create: `apps/api/src/modules/outcomes/repository.ts`
- Create: `apps/api/src/modules/backtests/repository.ts`
- Create: `apps/api/src/modules/evidence/repository.ts`
- Create: `apps/api/src/db/schema.sql`
- Create: `apps/api/test/repositories.test.ts`

**Step 1: Write the initial SQL schema**

Create tables:

- `events` (with `reference_class` column)
- `watchlists`
- `candidate_events`
- `evidence_items` (with `published_at` and no precomputed freshness column)
- `judgments`
- `judge_opinions`
- `outcomes`
- `calibration_snapshots` (with `weight_regime`, `resolved_outcome_count`)

Use:

- UUID primary keys
- JSONB for flexible payloads
- explicit status columns
- timestamps on every table

**Step 2: Wire the migration runner**

Ensure `scripts/db-migrate.sh` (created in Task 1) applies `apps/api/src/db/schema.sql` idempotently. Add a `pretest` hook in `apps/api/package.json` that runs the script against `DATABASE_URL` before the test suite so repository tests never face a cold container. Document the manual `pnpm run db:migrate` entrypoint in the README (updated in Task 13).

**Step 3: Implement repository modules**

Each module should expose focused functions, for example:

```ts
export async function createEvent(db: Pool, input: EventInput): Promise<EventRecord>
export async function insertEvidenceItems(db: Pool, items: EvidenceItem[]): Promise<void>
export async function createJudgmentRun(db: Pool, eventId: string): Promise<JudgmentRecord>
```

**Step 4: Add repository tests against local Postgres**

Cover:

- insert and fetch event (including `referenceClass` roundtrip)
- insert deduplicated evidence, preserving `publishedAt`
- append judgment trace history

**Step 5: Run repository tests**

Run:

```bash
pnpm --filter @cassandra/api test -- repositories
```

Expected:

- repository tests pass against local Postgres (migration runs automatically via `pretest`)

**Step 6: Commit persistence layer**

Run:

```bash
git add apps/api/src/modules apps/api/src/db apps/api/test/repositories.test.ts
git commit -m "feat: add postgres schema and repositories"
```

## Task 5: Add event, watchlist, and outcome routes

**Files:**
- Create: `apps/api/src/modules/events/routes.ts`
- Create: `apps/api/src/modules/watchlists/routes.ts`
- Create: `apps/api/src/modules/outcomes/routes.ts`
- Create: `apps/api/src/modules/backtests/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/events.test.ts`
- Test: `apps/api/test/watchlists.test.ts`
- Test: `apps/api/test/outcomes.test.ts`

**Step 1: Implement event routes**

Add:

- `POST /events`
- `GET /events/:id`
- `GET /events`

Reject events missing a resolvable deadline or resolution criteria.

**Step 2: Implement watchlist routes**

Add:

- `POST /watchlists`
- `GET /watchlists`
- `GET /watchlists/:id/candidates`

**Step 3: Implement outcomes and backtest trigger routes**

Add:

- `POST /outcomes`
- `POST /backtests/retrain`

**Step 4: Register route modules**

Wire all route plugins into `buildApp()`.

**Step 5: Add route tests**

Cover:

- happy-path event creation
- invalid event rejection
- watchlist creation and candidate list response
- outcome creation

**Step 6: Run route tests**

Run:

```bash
pnpm --filter @cassandra/api test -- events watchlists outcomes
```

Expected:

- route tests pass

**Step 7: Commit route layer**

Run:

```bash
git add apps/api/src/app.ts apps/api/src/modules apps/api/test
git commit -m "feat: add event watchlist and outcome routes"
```

## Task 6: Implement evidence adapters and normalization

**Files:**
- Create: `apps/api/src/modules/evidence/types.ts`
- Create: `apps/api/src/modules/evidence/normalize.ts`
- Create: `apps/api/src/modules/evidence/collector.ts`
- Create: `apps/api/src/modules/evidence/cache.ts`
- Create: `apps/api/src/modules/evidence/providers/perplexity.ts`
- Create: `apps/api/src/modules/evidence/providers/web.ts`
- Create: `apps/api/src/modules/evidence/providers/communitySearch.ts`
- Create: `apps/api/src/modules/evidence/providers/officialSearch.ts`
- Create: `apps/api/src/modules/evidence/providers/governmentSearch.ts`
- Create: `apps/api/src/modules/evidence/providers/polymarketGamma.ts`
- Create: `apps/api/src/modules/evidence/providers/polymarketClob.ts`
- Create: `apps/api/src/modules/evidence/providers/marketProvider.ts`
- Create: `apps/api/src/modules/evidence/providers/fixtureLoader.ts`
- Create: `apps/api/test/fixtures/providers/` (per-provider canned JSON)
- Test: `apps/api/test/evidence-normalize.test.ts`
- Test: `apps/api/test/evidence-collector.test.ts`
- Test: `apps/api/test/evidence-cache.test.ts`

**Step 1: Define provider interfaces**

Use one adapter contract:

```ts
export interface EvidenceProvider {
  name: string
  collect(input: CollectEvidenceInput): Promise<EvidenceItem[]>
}
```

**Step 2: Implement normalization**

Normalize:

- canonical URL
- publisher
- source-family enum
- `publishedAt` preserved verbatim (no `freshnessHours` field; freshness is derived at aggregation time, see design §7.2)
- claim list
- quality signals

Add duplicate collapsing by URL and fuzzy title hash.

**Step 3: Implement provider modules**

Each provider should:

- accept event context
- fetch external data
- map results into `EvidenceItem`
- never return provider-native payloads to the rest of the system
- honor `CASSANDRA_ADAPTER_MODE` — when `fixture`, the provider loads a canned response via `providers/fixtureLoader.ts` from `apps/api/test/fixtures/providers/<providerName>/<eventSlug>.json` instead of calling the live API. This lets the full stack run locally without real API keys and backs the test suite with the same files.

**Step 4: Implement the collector orchestration**

`collectEvidenceForEvent()` should call enabled providers, combine results, normalize, deduplicate, and persist them.

**Step 5: Implement the evidence cache**

`evidence/cache.ts` wraps the collector with a Redis-backed cache keyed on `(canonical_event_question_hash, evaluationTime_hour_bucket, providerName)`. The hour bucket makes cache hits align with historical-replay cutoffs. TTL is configurable (default 7 days). When `CASSANDRA_ADAPTER_MODE=fixture` the cache is bypassed (fixtures *are* the cache). Cache hits and misses must be recorded so the debug trace can show whether evidence was recomputed or replayed (see design §13.2).

**Step 6: Add contract fixtures**

Record fixture JSON responses for:

- Perplexity result payload
- Polymarket Gamma market data
- Polymarket CLOB price history
- custom market-provider quote response

**Step 7: Run evidence tests**

Run:

```bash
pnpm --filter @cassandra/api test -- evidence
```

Expected:

- normalization, collector, and cache tests pass

**Step 8: Commit evidence layer**

Run:

```bash
git add apps/api/src/modules/evidence apps/api/test
git commit -m "feat: add evidence adapters and normalization"
```

## Task 7: Implement watchlist discovery workers

**Files:**
- Create: `apps/api/src/workers/watchlistWorker.ts`
- Create: `apps/api/src/modules/watchlists/discovery.ts`
- Create: `apps/api/src/modules/watchlists/cluster.ts`
- Test: `apps/api/test/watchlist-discovery.test.ts`

**Step 1: Implement candidate discovery**

Discovery should:

- collect evidence for a watchlist topic
- identify repeated emerging claims
- cluster similar candidates by `clusterKey`
- emit `candidate_events` records

**Step 2: Implement a worker entrypoint**

`watchlistWorker.ts` should:

- read pending watchlist jobs
- invoke discovery
- upsert candidate events

**Step 3: Add tests**

Cover:

- clustering similar article headlines into one candidate
- leaving distinct claims separate
- manual promotion status remaining untouched by later discovery runs

**Step 4: Run discovery tests**

Run:

```bash
pnpm --filter @cassandra/api test -- watchlist-discovery
```

Expected:

- discovery tests pass

**Step 5: Commit watchlist discovery**

Run:

```bash
git add apps/api/src/workers apps/api/src/modules/watchlists apps/api/test/watchlist-discovery.test.ts
git commit -m "feat: add watchlist discovery worker"
```

## Task 8: Build the Python judge service contract

**Files:**
- Create: `services/judge/pyproject.toml`
- Create: `services/judge/app/main.py`
- Create: `services/judge/app/api.py`
- Create: `services/judge/app/models.py`
- Create: `services/judge/app/models_generated.py` (generated, checked in)
- Create: `services/judge/scripts/generate-models.sh`
- Create: `services/judge/tests/test_health.py`
- Create: `services/judge/tests/test_models.py`

**Step 1: Create the FastAPI service**

Add endpoints:

- `GET /health`
- `POST /judge`
- `POST /calibrate`

**Step 2: Generate Pydantic models from shared JSON Schema**

Do not hand-write Pydantic mirrors of the Zod schemas. Instead:

1. Run the Task 2 exporter (`pnpm --filter @cassandra/shared build`) to produce `packages/shared/dist/schemas.json`.
2. Add `services/judge/scripts/generate-models.sh` that invokes `uv run datamodel-codegen --input ../../packages/shared/dist/schemas.json --input-file-type jsonschema --output services/judge/app/models_generated.py`.
3. `services/judge/app/models.py` re-exports the generated types and only adds Python-only helpers (e.g., converters used internally by the scoring modules).
4. Add a CI/pretest guard: `test_models.py` re-runs the generator into a temp file and asserts it matches the checked-in `models_generated.py`. If someone changes Zod schemas without regenerating, the test fails.

This makes Zod the single source of truth for both services and prevents silent drift of the `VerdictTrace` / `JudgeOpinion` / `CalibrationSnapshot` shapes across the HTTP boundary.

**Step 3: Add service tests**

Cover:

- health endpoint
- payload validation against generated models
- `judge` endpoint returning a structured trace shape
- model-drift guard described in Step 2

**Step 4: Run judge-service tests**

Run:

```bash
cd services/judge && uv run pytest -q
```

Expected:

- FastAPI tests pass
- model-drift guard passes

**Step 5: Commit judge service skeleton**

Run:

```bash
git add services/judge
git commit -m "feat: scaffold judge service"
```

## Task 9: Implement specialized judges and aggregation math

**Files:**
- Create: `services/judge/app/scoring/judges/official_records.py`
- Create: `services/judge/app/scoring/judges/community_signal.py`
- Create: `services/judge/app/scoring/judges/open_web_research.py`
- Create: `services/judge/app/scoring/judges/cross_examiner.py`
- Create: `services/judge/app/scoring/judges/_fake_llm.py`
- Create: `services/judge/app/scoring/priors.py`
- Create: `services/judge/app/scoring/strength_map.py`
- Create: `services/judge/app/scoring/aggregate.py`
- Create: `services/judge/app/scoring/uncertainty.py`
- Create: `services/judge/app/scoring/weights.py`
- Create: `services/judge/tests/test_judges.py`
- Create: `services/judge/tests/test_priors.py`
- Create: `services/judge/tests/test_aggregate.py`
- Create: `services/judge/tests/test_uncertainty.py`
- Create: `services/judge/tests/test_strength_map.py`
- Create: `services/judge/tests/test_weights.py`

Note: `market_prior.py` is intentionally not listed. Market and prediction-market signals feed the prior, not the judge panel — see design §8.3 and §8.5. Their handling lives in `priors.py`.

**Step 1: Implement evidence-reading judge functions**

Each evidence-reading judge exposes a pure function:

```python
def evaluate(event: EventPayload, evidence: list[EvidenceItem]) -> RawJudgeOpinion:
    ...
```

A `RawJudgeOpinion` carries only what the LLM produces:

- `probability` (sanity-check display value)
- `evidenceStrength` (Likert ordinal from design §8.3.1)
- `rationale`
- `evidenceIds`
- `warnings`
- `missingEvidence`

It does **not** carry `logBayesFactor`, `baseWeight`, `dependencyDiscount`, or `freshnessDecay` — those are derived by the aggregator in Step 4.

The cross-examiner is qualitative: it reads the other judges' raw opinions and returns a structured `conflicts` list plus per-judge warnings. It does not produce any scalar penalty.

**Step 2: Implement the Likert → log Bayes factor mapping**

`strength_map.py` contains the fixed table from design §8.3.1:

```python
STRENGTH_TO_LOG_BF: dict[str, float] = {
    "strong_against":   -3.0,
    "moderate_against": -1.5,
    "weak_against":     -0.5,
    "neutral":           0.0,
    "weak_for":         +0.5,
    "moderate_for":     +1.5,
    "strong_for":       +3.0,
}
```

Expose a `to_log_bf(strength)` helper and a `from_calibration(snapshot)` override hook used only in the `steady` regime.

**Step 3: Implement forecasting-theory modules**

Implement `priors.py` with:

- empirical-Bayes base-rate prior estimation by `referenceClass`
- shrinkage toward a global `Beta(1, 1)` prior when a class has fewer than the minimum-sample threshold; set `referenceClassFallback=True` in that case
- liquidity-adjusted market prior: convert market prices to log-odds, then discount by spread, depth, and recent volatility
- `build_prior_log_odds(event, snapshot, market_signals) -> PriorResult` that produces the blended `alpha * logit(base_rate) + (1 - alpha) * logit(market)` term for the aggregator

Implement `weights.py` with:

- initial expert weights in the `cold_start` regime (uniform across judges, no online updates)
- exponentially weighted online updates from rolling proper-score regret in `warming` (halved step size) and `steady` regimes
- caps and floors preventing any judge from collapsing to zero or dominating
- a `select_regime(resolved_outcome_count) -> Literal["cold_start","warming","steady"]` helper used by the calibration pipeline (Task 10)

Implement `uncertainty.py` with:

- block bootstrap over evidence clusters
- judge-subset resampling
- conversion of bootstrap spread into `confidenceLow` and `confidenceHigh`

**Step 4: Implement aggregation math**

Implement in `aggregate.py`:

- probability ↔ log-odds conversion
- `jaccard_overlap_matrix(judge_opinions)` and `dependency_discounts(matrix)` implementing the design §8.5.1 formula: `n_eff_j = 1 / (1 + sum_{k≠j} jaccard_{jk})`
- `disagreement_shrinkage(weighted_log_odds)` implementing design §8.5.2: `shrinkage = clip(k_disagree * var(weighted_log_odds), 0, shrinkage_max)` with defaults `k_disagree=0.25, shrinkage_max=0.6`
- per-judge freshness decay as `exp(-age_hours / half_life_hours)` where `age_hours = evaluationTime - publishedAt`
- evidence-quality modifier aggregation capped in `[0.5, 1.5]`
- the full posterior assembly: `raw_posterior_log_odds = prior_log_odds + Σ (base_weight · dependency_discount · evidence_quality · freshness_decay · log_bf)`, then `posterior_log_odds = (1 - shrinkage) * raw_posterior_log_odds`
- calibration-ready raw probability output
- `finalize_judge_opinion(raw, derived)` that merges a `RawJudgeOpinion` with aggregator-derived fields into the persisted `JudgeOpinion`

The cross-examiner's `conflicts` list is attached to the trace but never feeds the shrinkage scalar.

**Step 5: Add deterministic tests**

Split tests into pure-math files (no LLM calls) and judge files that use `_fake_llm.py` to return canned Likert picks:

- `test_strength_map.py` — mapping is monotonic and symmetric; unknown strings raise
- `test_priors.py` — empirical-Bayes shrinks sparse classes toward `Beta(1, 1)`; market priors are discounted by spread and volatility; `alpha=0` path when class is unsampled
- `test_aggregate.py`:
  - probability edge cases near 0 and 1
  - Bayes-factor contributions composing additively in log-odds space
  - two judges citing identical evidence yielding `dependency_discount ≈ 0.5` each, halving their pooled effect
  - disagreement shrinkage activating when judge log-odds variance crosses the threshold, pulling toward prior (not toward 0.5)
  - stale evidence (large `age_hours`) contributing less than fresh evidence
  - zero-shrinkage when all judges agree
- `test_uncertainty.py` — bootstrap widens when evidence clusters disagree
- `test_judges.py` — each evidence-reading judge returns a valid `RawJudgeOpinion` against a fake LLM that produces fixture Likert picks; cross-examiner returns a non-empty `conflicts` list when opinions diverge and an empty list when they agree
- `test_weights.py` — `select_regime` switches at N=20 and N=100; `cold_start` never updates weights; `steady` moves weights toward judges with lower regret

Integration tests that hit real OpenRouter go in a separate file gated on `OPENROUTER_INTEGRATION=1` and are skipped by default.

**Step 6: Run judge and math tests**

Run:

```bash
cd services/judge && uv run pytest -q tests/test_judges.py tests/test_priors.py tests/test_aggregate.py tests/test_uncertainty.py tests/test_strength_map.py tests/test_weights.py
```

Expected:

- deterministic scoring tests pass

**Step 7: Commit scoring engine**

Run:

```bash
git add services/judge/app/scoring services/judge/tests
git commit -m "feat: add judge panel and aggregation math"
```



## Task 10: Implement calibration and backtesting

**Files:**
- Create: `services/judge/app/scoring/calibration.py`
- Create: `services/judge/tests/test_calibration.py`
- Modify: `services/judge/app/api.py`
- Modify: `apps/api/src/modules/backtests/routes.ts`
- Modify: `apps/api/src/modules/backtests/repository.ts`

**Step 1: Implement calibration logic**

Add functions to:

- compute Brier score
- compute log loss
- compute reliability curves and calibration error by `referenceClass`
- fit isotonic calibration from historical predictions and outcomes
- fall back to logistic or beta calibration when isotonic is underdetermined
- update expert weights with exponentially weighted regret
- return judge weights, calibration parameters, and online-learning parameters

All of the above must respect the cold-start regimes from design §8.5.3. Use the `select_regime` helper from `weights.py` (Task 9):

- `N < 20` (`cold_start`): return a snapshot with uniform judge weights, identity calibration map, and `weightRegime="cold_start"`. Do not attempt to fit isotonic, logistic, or online updates — there is not enough signal.
- `20 ≤ N < 100` (`warming`): fit logistic or beta calibration only, run exponentially weighted updates with step size halved, and set `weightRegime="warming"`.
- `N ≥ 100` (`steady`): fit isotonic with logistic fallback, run full EW updates, and set `weightRegime="steady"`.

Always persist `resolvedOutcomeCount` on the snapshot so the active regime is auditable.

**Step 2: Expose the calibration API**

`POST /calibrate` should accept historical traces and outcomes and return a versioned snapshot payload containing `weightRegime`, `resolvedOutcomeCount`, judge weights, calibration parameters, and online-learning parameters.

**Step 3: Persist snapshots from the API service**

Backtest route should:

- load outcomes and historical traces from Postgres
- call judge-service calibration endpoint
- save a new `calibration_snapshots` row, including `weight_regime` and `resolved_outcome_count`

**Step 4: Add tests**

Cover:

- metric calculations
- `cold_start` regime producing uniform weights and identity calibration with `N=0` and `N=19`
- `warming` regime producing logistic/beta output and halved-step EW updates at `N=20` and `N=99`
- `steady` regime producing isotonic output (monotonic) at `N=100`, with logistic fallback on degenerate data
- weight updates favoring judges with lower proper-score regret (only in `warming` / `steady`)
- stable output format
- snapshot persistence preserving `weightRegime` and `resolvedOutcomeCount`

**Step 5: Run calibration tests**

Run:

```bash
cd services/judge && uv run pytest -q tests/test_calibration.py
pnpm --filter @cassandra/api test -- backtests
```

Expected:

- calibration and persistence tests pass

**Step 6: Commit calibration flow**

Run:

```bash
git add services/judge apps/api/src/modules/backtests
git commit -m "feat: add calibration and backtesting"
```

## Task 10A: Benchmark schema, Polymarket import, and metrics module

This task covers the evaluation *infrastructure* — tables, import, and pure-function metrics — so that the dataset can be loaded before the judge pipeline is live. The replay runner, baselines, and routes depend on Task 11 and are deferred to Task 10B.

**Files:**
- Create: `apps/api/src/modules/evaluation/repository.ts`
- Create: `apps/api/src/modules/evaluation/polymarketImport.ts`
- Create: `apps/api/src/modules/evaluation/metrics.ts`
- Create: `apps/api/src/db/evaluation_schema.sql`
- Test: `apps/api/test/evaluation-metrics.test.ts`
- Test: `apps/api/test/evaluation-import.test.ts`

**Step 1: Implement benchmark persistence**

Extend `schema.sql` (or add a sibling `evaluation_schema.sql` loaded by the same migration runner) with tables for:

- imported benchmark markets
- historical price snapshots by cutoff
- evaluation runs
- per-market predictions
- aggregated slice metrics

Imported Polymarket records must preserve:

- original question text
- exact resolution criteria
- resolution URL if available
- theme or tag metadata
- liquidity and volume metadata
- resolution timestamp

**Step 2: Implement Polymarket benchmark import**

`polymarketImport.ts` should:

- fetch recently resolved binary markets
- normalize them into `BenchmarkMarket`
- exclude canceled or structurally ambiguous markets
- stratify by theme and retain the import audit trail

**Step 3: Implement evaluation metrics**

`metrics.ts` should compute, as pure functions operating on arrays of `{ predicted, outcome }` pairs plus metadata:

- Brier score
- log loss
- calibration bins and expected calibration error
- average absolute error
- win rate versus a reference (used by the runner for `polymarket_only`)
- slice metrics by theme, horizon, and source configuration

**Step 4: Add tests**

Cover:

- imports excluding canceled or incompatible markets
- metric calculations on a fixed fixture set (deterministic)
- ECE and calibration-bin edge cases

**Step 5: Run tests**

Run:

```bash
pnpm --filter @cassandra/api test -- evaluation
```

Expected:

- evaluation import and metrics tests pass

**Step 6: Commit benchmark infrastructure**

Run:

```bash
git add apps/api/src/modules/evaluation apps/api/src/db apps/api/test
git commit -m "feat: add evaluation benchmark schema and metrics"
```

## Task 11: Wire API orchestration to the judge service

**Files:**
- Create: `apps/api/src/modules/judgments/routes.ts`
- Create: `apps/api/src/modules/judgments/service.ts`
- Create: `apps/api/src/modules/judgments/judgeCache.ts`
- Create: `apps/api/src/workers/judgmentWorker.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/judgments.test.ts`
- Test: `apps/api/test/judge-cache.test.ts`

**Step 1: Implement judgment service orchestration**

The service should:

- load event context
- collect or refresh evidence (via the Task 6 evidence cache)
- load latest calibration snapshot
- call `POST /judge`, wrapped by the judge output cache from Step 2
- persist the resulting trace and judge opinions

**Step 2: Implement the judge output cache**

`judgments/judgeCache.ts` is a Redis-backed wrapper around the judge-service call, keyed on `(judgeName, sorted(evidenceIds)_hash, judgeModelVersion, promptVersion, snapshotId)`. Values are raw `JudgeOpinion` records. Defaults per design §13.2: hours-to-a-day TTL, bypassed when `CASSANDRA_ADAPTER_MODE=fixture`. Every cache hit and miss is recorded in the debug trace so a reviewer can tell whether a given judgment was computed or replayed.

This cache is what makes Task 10B (evaluation runner) tractable: the `model_without_polymarket` and `model_with_polymarket` baselines share almost all non-market judge computations through this layer.

**Step 3: Add judgment routes**

Expose:

- `POST /judgments`
- `GET /judgments/:id`

**Step 4: Add background worker**

`judgmentWorker.ts` should process queued judgment runs and update status fields.

**Step 5: Add integration-style tests**

Cover:

- queued judgment run reaching `completed`
- response includes judge opinions, citations, and calibration metadata
- insufficient-evidence path returns neutral-ish probability and explicit status
- judge output cache hit returns the same `JudgeOpinion` without calling the judge service (use a mock that counts invocations)
- cache bypass path when `CASSANDRA_ADAPTER_MODE=fixture`

**Step 6: Run judgment tests**

Run:

```bash
pnpm --filter @cassandra/api test -- judgments
```

Expected:

- judgment integration tests pass

**Step 7: Commit orchestration**

Run:

```bash
git add apps/api/src/modules/judgments apps/api/src/workers apps/api/test/judgments.test.ts apps/api/test/judge-cache.test.ts apps/api/src/app.ts
git commit -m "feat: wire api to judge service"
```

## Task 10B: Historical replay runner and evaluation routes

This task depends on Task 11. It wires the benchmark dataset from Task 10A to the live judgment pipeline, runs the four baselines over historical cutoffs, and exposes evaluation routes.

**Files:**
- Create: `apps/api/src/modules/evaluation/replay.ts`
- Create: `apps/api/src/modules/evaluation/baselines.ts`
- Create: `apps/api/src/modules/evaluation/routes.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/evaluation-replay.test.ts`
- Test: `apps/api/test/evaluation-baselines.test.ts`

**Step 1: Implement historical replay**

`replay.ts` should:

- create cutoffs at `T-30d`, `T-7d`, `T-1d`, and `T-6h`
- reconstruct event inputs from benchmark markets, including a `referenceClass` tag where available
- filter evidence to timestamps at or before each cutoff using the `publishedAt` field (never wall clock)
- set `evaluationTime` on the judgment call to the cutoff timestamp so freshness decay computes correctly
- capture the Polymarket implied probability at each cutoff
- label each run with `replayFidelity = approximate` when any provider lacked archived retrieval
- run the configured baselines against the same benchmark item, leveraging the Task 6 evidence cache and the Task 11 judge output cache to avoid redundant work

**Step 2: Implement evaluation baselines**

`baselines.ts` must support:

- `base_rate_only` — empirical-Bayes prior with no live evidence
- `polymarket_only` — the cutoff-time implied probability, no judgment pipeline
- `model_without_polymarket` — full pipeline with Polymarket-family evidence providers disabled at the collector level (not just filtered downstream); the orchestration must fail closed if a Polymarket-sourced `EvidenceItem` reaches the judges
- `model_with_polymarket` — full pipeline

**Step 3: Expose evaluation routes**

Add:

- `POST /evaluation/benchmarks/import/polymarket` (moved from Task 10A)
- `POST /evaluation/runs`
- `GET /evaluation/runs/:id`

`GET /evaluation/runs/:id` must return:

- overall metrics
- per-baseline metrics
- per-theme and per-horizon slices
- leakage and replay-fidelity flags

**Step 4: Add tests**

Cover:

- replay using only pre-cutoff evidence (`publishedAt ≤ cutoff`)
- `model_without_polymarket` failing closed if Polymarket evidence leaks into the collector
- per-baseline metrics agreeing with the Task 10A pure-function `metrics.ts`
- per-slice reporting shape remaining stable
- eval runs reusing cached judge outputs across baselines (counted by mock invocation)

**Step 5: Run tests**

Run:

```bash
pnpm --filter @cassandra/api test -- evaluation-replay evaluation-baselines
```

Expected:

- replay and baseline tests pass

**Step 6: Commit runner**

Run:

```bash
git add apps/api/src/modules/evaluation apps/api/src/app.ts apps/api/test/evaluation-replay.test.ts apps/api/test/evaluation-baselines.test.ts
git commit -m "feat: add evaluation replay runner"
```

## Task 12: Build the minimal inspection UI

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/pages/EventListPage.tsx`
- Create: `apps/web/src/pages/EventDetailPage.tsx`
- Create: `apps/web/src/pages/WatchlistPage.tsx`
- Create: `apps/web/src/pages/JudgmentTracePage.tsx`
- Create: `apps/web/src/components/ProbabilityCard.tsx`
- Create: `apps/web/src/components/JudgeOpinionCard.tsx`
- Create: `apps/web/src/components/EvidenceTimeline.tsx`
- Test: `apps/web/src/App.test.tsx`

**Step 1: Scaffold the web app**

Create a Vite React app with:

- router
- API client
- base layout

**Step 2: Implement event and watchlist pages**

Support:

- event list and event creation form
- watchlist list and candidate table

**Step 3: Implement the judgment trace page**

Render:

- final probability
- confidence band
- source-family breakdown
- judge cards
- evidence timeline
- conflict list

**Step 4: Add UI smoke tests**

Cover:

- event list renders
- trace page renders API data
- judge cards display rationale text

**Step 5: Run UI tests**

Run:

```bash
pnpm --filter @cassandra/web test
pnpm --filter @cassandra/web build
```

Expected:

- UI tests and production build pass

**Step 6: Commit web UI**

Run:

```bash
git add apps/web
git commit -m "feat: add operator inspection ui"
```

## Task 13: Add end-to-end verification and local runbook

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Create: `apps/api/test/fixtures/`
- Create: `services/judge/tests/fixtures/`
- Create: `docs/plans/verification-checklist.md`

**Step 1: Document startup and environment setup**

README must include:

- dependency prerequisites
- `pnpm install`
- `uv sync`
- `docker compose up`
- service URLs
- test commands

**Step 2: Add fixture-backed integration coverage**

Create fixture directories and ensure tests can run without live external APIs for the main flows.

**Step 3: Write the verification checklist**

Document a manual validation flow:

1. start infra
2. create event
3. run judgment
4. inspect trace in UI
5. record outcome
6. retrain calibration
7. import resolved Polymarket benchmarks
8. run historical evaluation and inspect baseline comparisons

**Step 4: Run the full verification suite**

Run:

```bash
pnpm test
cd services/judge && uv run pytest -q
docker compose up -d
```

Expected:

- all automated tests pass
- local stack starts cleanly

**Step 5: Commit docs and verification**

Run:

```bash
git add README.md .env.example docs/plans/verification-checklist.md apps/api/test/fixtures services/judge/tests/fixtures
git commit -m "docs: add runbook and verification checklist"
```

## Acceptance Criteria

- `POST /events` creates a valid event and persists it, including the selected `referenceClass`.
- `POST /judgments` can produce a stored `VerdictTrace` for a valid event in `CASSANDRA_ADAPTER_MODE=fixture` with no live external API calls.
- At least four evidence families can contribute to a single judgment in test fixtures.
- A watchlist run can emit candidate events and preserve manual promotion state.
- `POST /outcomes` records a resolution and `POST /backtests/retrain` creates a calibration snapshot carrying the active `weightRegime` and `resolvedOutcomeCount`.
- `POST /evaluation/runs` can replay historical benchmarks at fixed cutoffs using only `publishedAt ≤ cutoff` evidence, produce baseline comparisons including `model_without_polymarket` failing closed on Polymarket leakage, and label `replayFidelity` per run.
- The web UI can display a trace with judge breakdown, `evidenceStrength` per judge, `dependencyMatrix`, `disagreementShrinkage`, and citations.
- The shared-schema JSON Schema export drives Pydantic model generation; the model-drift guard test fails when schemas diverge.

## Defaults And Assumptions

- Package names use the `@cassandra/*` namespace.
- API-to-judge communication is synchronous HTTP in v1.
- Live external API calls are wrapped behind adapters and excluded from default test runs. `CASSANDRA_ADAPTER_MODE=fixture` is the default mode for local development and the test suite.
- Postgres schema can begin as raw SQL; ORM adoption is unnecessary for the first prototype. Migrations are applied via `scripts/db-migrate.sh` wired into the API `pretest` hook.
- UI styling should stay utilitarian and trace-focused rather than product-polished.
- The first evaluation benchmark uses recently resolved binary Polymarket markets stratified by theme, not only the highest-volume markets.
- Redis-backed caches (evidence and judge output) are required for any evaluation run at scale; live mode without caches is only suitable for one-off judgments.

## Execution Notes

- Implement in task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 10A → 11 → 10B → 12 → 13. Task 10B depends on Task 11, which is why the evaluation harness is split across 10A (schema + import + metrics) and 10B (runner + baselines + routes).
- Keep commits scoped to one task.
- Do not skip fixture-backed tests; they are the boundary against API drift.
- Prefer deterministic math tests in Python before tuning live prompts or models.
- Treat replay-fidelity flags as first-class outputs because historical retrieval is never perfectly clean.
- Never pre-compute freshness at ingest time — always derive it at aggregation time from `evaluationTime - publishedAt`, so the same evidence row can be reused across replay cutoffs without mutation.

Plan complete and saved to `docs/plans/2026-04-11-multisource-forecast-judge-implementation-plan.md`. Two execution options:

1. Subagent-Driven (this session) - I dispatch fresh subagent per task, review between tasks, fast iteration
2. Parallel Session (separate) - Open new session with executing-plans, batch execution with checkpoints
