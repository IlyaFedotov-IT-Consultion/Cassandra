# Multi-Source Forecast Judge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local-Docker research prototype that ingests multi-source evidence, produces traceable probability judgments for events, and supports watchlists plus backtesting.

**Architecture:** Use a `pnpm` workspace for the TypeScript API, shared package, and React UI, plus a Python FastAPI service for the mathematical judge. Persist all durable records in Postgres, use Redis for queues, and connect the API to the judge service over HTTP with shared JSON schemas.

**Tech Stack:** pnpm, TypeScript, Fastify, React, Vite, Vitest, PostgreSQL, Redis, BullMQ, Python, FastAPI, Pydantic, NumPy, scikit-learn, Docker Compose, Playwright

---

## Mathematical Foundations To Implement

The judging core is not a generic score blender. The implementation must explicitly include:

- reference-class forecasting through empirical-Bayes base-rate priors
- liquidity-adjusted market and prediction-market priors
- Bayesian evidence updates expressed as bounded log Bayes factors
- regularized logarithmic opinion pooling in log-odds space
- proper scoring rules: Brier score and log score
- online expert reweighting with exponentially weighted updates
- isotonic calibration with logistic fallback
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

**Step 1: Create the workspace root files**

Write root files defining:

- workspace packages: `apps/*`, `packages/*`
- common TypeScript compiler settings
- root scripts: `dev`, `build`, `test`, `lint`
- service environment variables
- Docker services for `postgres`, `redis`, `api`, `judge`, and `web`

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
- Test: `packages/shared/src/schemas.ts`

**Step 1: Define the canonical schemas**

Implement Zod schemas and exported types for:

- `EventInput`
- `WatchlistInput`
- `CandidateEvent`
- `EvidenceItem`
- `JudgeOpinion`
- `VerdictTrace`
- `OutcomeInput`
- `CalibrationSnapshot`
- `BenchmarkMarket`
- `EvaluationRun`
- `EvaluationSliceResult`

Use exact enum values for source families and judgment statuses so API and UI cannot drift.

Ensure the mathematical trace fields are part of the schema from day one:

- `JudgeOpinion.logBayesFactor`
- `JudgeOpinion.reliabilityWeight`
- `JudgeOpinion.dependencyDiscount`
- `VerdictTrace.priorProbability`
- `VerdictTrace.rawPosteriorProbability`
- `VerdictTrace.ensembleMethod`
- `VerdictTrace.calibrationMethod`
- `VerdictTrace.uncertaintyMethod`
- `CalibrationSnapshot.baseRateParams`
- `CalibrationSnapshot.marketPriorParams`
- `CalibrationSnapshot.onlineLearningParams`

**Step 2: Add representative schema tests**

Create tests or inline assertions validating:

- valid event input parses
- invalid source family rejects
- verdict trace requires judge opinions and citations

**Step 3: Verify the package builds**

Run:

```bash
pnpm --filter @cassandra/shared build
```

Expected:

- TypeScript compilation succeeds

**Step 4: Commit shared schemas**

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

- `events`
- `watchlists`
- `candidate_events`
- `evidence_items`
- `judgments`
- `judge_opinions`
- `outcomes`
- `calibration_snapshots`

Use:

- UUID primary keys
- JSONB for flexible payloads
- explicit status columns
- timestamps on every table

**Step 2: Implement repository modules**

Each module should expose focused functions, for example:

```ts
export async function createEvent(db: Pool, input: EventInput): Promise<EventRecord>
export async function insertEvidenceItems(db: Pool, items: EvidenceItem[]): Promise<void>
export async function createJudgmentRun(db: Pool, eventId: string): Promise<JudgmentRecord>
```

**Step 3: Add repository tests against local Postgres**

Cover:

- insert and fetch event
- insert deduplicated evidence
- append judgment trace history

**Step 4: Run repository tests**

Run:

```bash
pnpm --filter @cassandra/api test -- repositories
```

Expected:

- repository tests pass against local Postgres

**Step 5: Commit persistence layer**

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
- Create: `apps/api/src/modules/evidence/providers/perplexity.ts`
- Create: `apps/api/src/modules/evidence/providers/web.ts`
- Create: `apps/api/src/modules/evidence/providers/communitySearch.ts`
- Create: `apps/api/src/modules/evidence/providers/officialSearch.ts`
- Create: `apps/api/src/modules/evidence/providers/governmentSearch.ts`
- Create: `apps/api/src/modules/evidence/providers/polymarketGamma.ts`
- Create: `apps/api/src/modules/evidence/providers/polymarketClob.ts`
- Create: `apps/api/src/modules/evidence/providers/marketProvider.ts`
- Test: `apps/api/test/evidence-normalize.test.ts`
- Test: `apps/api/test/evidence-collector.test.ts`

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
- freshness hours
- claim list
- quality signals

Add duplicate collapsing by URL and fuzzy title hash.

**Step 3: Implement provider modules**

Each provider should:

- accept event context
- fetch external data
- map results into `EvidenceItem`
- never return provider-native payloads to the rest of the system

**Step 4: Implement the collector orchestration**

`collectEvidenceForEvent()` should call enabled providers, combine results, normalize, deduplicate, and persist them.

**Step 5: Add contract fixtures**

Record fixture JSON responses for:

- Perplexity result payload
- Polymarket Gamma market data
- Polymarket CLOB price history
- custom market-provider quote response

**Step 6: Run evidence tests**

Run:

```bash
pnpm --filter @cassandra/api test -- evidence
```

Expected:

- normalization and collector tests pass

**Step 7: Commit evidence layer**

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
- Create: `services/judge/tests/test_health.py`
- Create: `services/judge/tests/test_models.py`

**Step 1: Create the FastAPI service**

Add endpoints:

- `GET /health`
- `POST /judge`
- `POST /calibrate`

**Step 2: Mirror the shared API contract in Pydantic**

Define models for:

- event payload
- evidence items
- judge opinions
- verdict trace
- calibration request and response

**Step 3: Add service tests**

Cover:

- health endpoint
- payload validation
- `judge` endpoint returning a structured trace shape

**Step 4: Run judge-service tests**

Run:

```bash
cd services/judge && uv run pytest -q
```

Expected:

- FastAPI tests pass

**Step 5: Commit judge service skeleton**

Run:

```bash
git add services/judge
git commit -m "feat: scaffold judge service"
```

## Task 9: Implement specialized judges and aggregation math

**Files:**
- Create: `services/judge/app/scoring/judges/market_prior.py`
- Create: `services/judge/app/scoring/judges/official_records.py`
- Create: `services/judge/app/scoring/judges/community_signal.py`
- Create: `services/judge/app/scoring/judges/open_web_research.py`
- Create: `services/judge/app/scoring/judges/cross_examiner.py`
- Create: `services/judge/app/scoring/priors.py`
- Create: `services/judge/app/scoring/aggregate.py`
- Create: `services/judge/app/scoring/uncertainty.py`
- Create: `services/judge/app/scoring/weights.py`
- Create: `services/judge/tests/test_judges.py`
- Create: `services/judge/tests/test_priors.py`
- Create: `services/judge/tests/test_aggregate.py`
- Create: `services/judge/tests/test_uncertainty.py`

**Step 1: Implement judge functions**

Each judge should expose a pure function:

```python
def evaluate(event: EventPayload, evidence: list[EvidenceItem]) -> JudgeOpinion:
    ...
```

At minimum, each judge must return:

- probability
- confidence
- log Bayes factor
- reliability weight
- dependency discount
- rationale
- evidence ids
- warnings

`market_prior.py` must produce both:

- a liquidity-adjusted market prior probability
- a bounded market-derived log Bayes factor contribution

**Step 2: Implement forecasting-theory modules**

Implement `priors.py` with:

- empirical-Bayes base-rate prior estimation
- shrinkage toward a global prior for sparse event classes
- liquidity adjustment for market and Polymarket-derived priors

Implement `weights.py` with:

- initial expert weights
- exponentially weighted online updates from rolling proper-score regret
- caps and floors to prevent one judge from collapsing to zero or one

Implement `uncertainty.py` with:

- block bootstrap over evidence clusters
- judge-subset resampling
- conversion of bootstrap spread into `confidenceLow` and `confidenceHigh`

**Step 3: Implement aggregation math**

Implement:

- probability to log-odds conversion
- Bayes-factor to posterior-log-odds updates
- regularized logarithmic opinion pooling
- freshness decay
- quality modifiers
- dependency discounts
- contradiction penalty
- isotonic-ready raw posterior output
- confidence-band generation

**Step 4: Add deterministic tests**

Cover:

- probability edge cases near 0 and 1
- empirical-Bayes priors shrinking sparse classes toward the global base rate
- market priors being discounted when spread is high and liquidity is low
- Bayes-factor contributions composing additively in log-odds space
- dependency penalties reducing double-counting from overlapping judges
- disagreement penalties lowering confidence
- stale evidence contributing less than fresh evidence
- bootstrap uncertainty widening when evidence clusters disagree
- expert weights moving toward better-scoring judges over repeated resolved events

**Step 5: Run judge and math tests**

Run:

```bash
cd services/judge && uv run pytest -q tests/test_judges.py tests/test_priors.py tests/test_aggregate.py tests/test_uncertainty.py
```

Expected:

- deterministic scoring tests pass

**Step 6: Commit scoring engine**

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
- compute reliability curves and calibration error by event family
- fit isotonic calibration from historical predictions and outcomes
- fall back to logistic or beta calibration when isotonic is underdetermined
- update expert weights with exponentially weighted regret
- return judge weights, calibration parameters, and online-learning parameters

**Step 2: Expose the calibration API**

`POST /calibrate` should accept historical traces and outcomes and return a versioned snapshot payload.

**Step 3: Persist snapshots from the API service**

Backtest route should:

- load outcomes and historical traces from Postgres
- call judge-service calibration endpoint
- save a new `calibration_snapshots` row

**Step 4: Add tests**

Cover:

- metric calculations
- isotonic calibration output remaining monotonic
- logistic fallback activating on small samples
- weight updates favoring judges with lower proper-score regret
- stable output format
- snapshot persistence

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

## Task 10A: Build historical benchmark and evaluation harness

**Files:**
- Create: `apps/api/src/modules/evaluation/routes.ts`
- Create: `apps/api/src/modules/evaluation/repository.ts`
- Create: `apps/api/src/modules/evaluation/polymarketImport.ts`
- Create: `apps/api/src/modules/evaluation/replay.ts`
- Create: `apps/api/src/modules/evaluation/metrics.ts`
- Create: `apps/api/src/modules/evaluation/baselines.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/evaluation.test.ts`

**Step 1: Implement benchmark persistence**

Create tables and repository functions for:

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

**Step 3: Implement historical replay**

`replay.ts` should:

- create cutoffs at `T-30d`, `T-7d`, `T-1d`, and `T-6h`
- reconstruct event inputs from benchmark markets
- filter evidence to timestamps at or before each cutoff
- capture the Polymarket implied probability at each cutoff
- run the configured baselines against the same benchmark item

**Step 4: Implement evaluation baselines**

`baselines.ts` must support:

- `base_rate_only`
- `polymarket_only`
- `model_without_polymarket`
- `model_with_polymarket`

The orchestration must ensure the `model_without_polymarket` run does not accidentally read Polymarket-derived evidence.

**Step 5: Implement evaluation metrics**

`metrics.ts` should compute:

- Brier score
- log loss
- calibration bins and expected calibration error
- average absolute error
- win rate versus `polymarket_only`
- slice metrics by theme, horizon, and source configuration

**Step 6: Expose evaluation routes**

Add:

- `POST /evaluation/benchmarks/import/polymarket`
- `POST /evaluation/runs`
- `GET /evaluation/runs/:id`

`GET /evaluation/runs/:id` must return:

- overall metrics
- per-baseline metrics
- per-theme and per-horizon slices
- leakage and replay-fidelity flags

**Step 7: Add evaluation tests**

Cover:

- imports excluding canceled or incompatible markets
- replay using only pre-cutoff evidence
- `model_without_polymarket` not ingesting market-derived evidence
- metric calculations on a fixed fixture set
- per-slice reporting shape remaining stable

**Step 8: Run evaluation tests**

Run:

```bash
pnpm --filter @cassandra/api test -- evaluation
```

Expected:

- evaluation import, replay, and metrics tests pass

**Step 9: Commit evaluation harness**

Run:

```bash
git add apps/api/src/modules/evaluation apps/api/src/app.ts apps/api/test/evaluation.test.ts
git commit -m "feat: add historical evaluation harness"
```

## Task 11: Wire API orchestration to the judge service

**Files:**
- Create: `apps/api/src/modules/judgments/routes.ts`
- Create: `apps/api/src/modules/judgments/service.ts`
- Create: `apps/api/src/workers/judgmentWorker.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/judgments.test.ts`

**Step 1: Implement judgment service orchestration**

The service should:

- load event context
- collect or refresh evidence
- load latest calibration snapshot
- call `POST /judge`
- persist the resulting trace and judge opinions

**Step 2: Add judgment routes**

Expose:

- `POST /judgments`
- `GET /judgments/:id`

**Step 3: Add background worker**

`judgmentWorker.ts` should process queued judgment runs and update status fields.

**Step 4: Add integration-style tests**

Cover:

- queued judgment run reaching `completed`
- response includes judge opinions, citations, and calibration metadata
- insufficient-evidence path returns neutral-ish probability and explicit status

**Step 5: Run judgment tests**

Run:

```bash
pnpm --filter @cassandra/api test -- judgments
```

Expected:

- judgment integration tests pass

**Step 6: Commit orchestration**

Run:

```bash
git add apps/api/src/modules/judgments apps/api/src/workers apps/api/test/judgments.test.ts apps/api/src/app.ts
git commit -m "feat: wire api to judge service"
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

- `POST /events` creates a valid event and persists it.
- `POST /judgments` can produce a stored `VerdictTrace` for a valid event.
- At least four evidence families can contribute to a single judgment in test fixtures.
- A watchlist run can emit candidate events and preserve manual promotion state.
- `POST /outcomes` records a resolution and `POST /backtests/retrain` creates a calibration snapshot.
- `POST /evaluation/runs` can replay historical benchmarks at fixed cutoffs and produce baseline comparisons.
- The web UI can display a trace with judge breakdown and citations.

## Defaults And Assumptions

- Package names use the `@cassandra/*` namespace.
- API-to-judge communication is synchronous HTTP in v1.
- Live external API calls are wrapped behind adapters and excluded from default test runs.
- Postgres schema can begin as raw SQL; ORM adoption is unnecessary for the first prototype.
- UI styling should stay utilitarian and trace-focused rather than product-polished.
- The first evaluation benchmark uses recently resolved binary Polymarket markets stratified by theme, not only the highest-volume markets.

## Execution Notes

- Implement in task order.
- Keep commits scoped to one task.
- Do not skip fixture-backed tests; they are the boundary against API drift.
- Prefer deterministic math tests in Python before tuning live prompts or models.
- Treat replay-fidelity flags as first-class outputs because historical retrieval is never perfectly clean.

Plan complete and saved to `docs/plans/2026-04-11-multisource-forecast-judge-implementation-plan.md`. Two execution options:

1. Subagent-Driven (this session) - I dispatch fresh subagent per task, review between tasks, fast iteration
2. Parallel Session (separate) - Open new session with executing-plans, batch execution with checkpoints
