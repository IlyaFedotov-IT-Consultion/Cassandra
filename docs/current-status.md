# Current Project Status

**Reviewed on:** 2026-11-07, on branch `feat/multi-stage-forecasting-pipeline`

This page records what the repository does today, what is still partial, and what was verified at the last review. HTTP contracts are in [api-reference.md](api-reference.md). The architecture review and its remediation status are in [reviews/2026-11-07-architecture-and-algorithms-review.md](reviews/2026-11-07-architecture-and-algorithms-review.md).

## Summary

Cassandra is a working research prototype for multi-source event forecasting:

- **Shared contract:** [packages/shared/src/schemas.ts](../packages/shared/src/schemas.ts) holds Zod schemas used by both the API and the web app. Its build exports JSON Schema, from which the judge service's Pydantic models are generated.
- **Orchestration API:** a Fastify service in [apps/api](../apps/api). It stores data in Postgres and runs judgments through a Redis/BullMQ queue.
- **Judge service:** a FastAPI service in [services/judge](../services/judge) that turns evidence into a calibrated probability through a multi-stage pipeline.
- **Web workspace:** a React app in [apps/web](../apps/web) for reading forecasts, evidence, evaluation runs and calibration.

## Forecasting pipeline

Every judgment, in both `fixture` and `live` mode, goes through the judge service. The stages, recorded in `verdictTrace.pipelineStages`, are:

1. **Query planning:** generates sub-question search queries (judge `POST /plan`).
2. **Retrieval:** official, government, community and web search, Perplexity, and Polymarket Gamma/CLOB.
3. **Relevance rating:** scores sources and keeps only the relevant ones.
4. **Panel reasoning:** a multi-model judge ensemble, with a consistency guard that excludes samples whose label contradicts their probability.
5. **Cross-examination:** runs when at least two judges had evidence.
6. **Aggregation:** log-odds pooling around a prior that blends the base rate and the market price.
7. **Calibration:** applies the snapshot in use.

Models and reasoning effort are set only through the `OPENROUTER_*` variables in `.env.example`. The current choices are explained in [research/2026-11-07-llm-forecasting-methods.md](research/2026-11-07-llm-forecasting-methods.md).

## Components

### API

The API has 27 routes covering:

- health and readiness;
- events;
- watchlists, with candidate listing, on-demand discovery (`POST /watchlists/:id/discover`), and scheduled discovery on each watchlist's cadence (hourly, daily or weekly; `GET /watchlists/:id/schedule`);
- outcomes (recording, and listing newest first);
- judgments (queueing, detail and listing);
- runtime activity;
- calibration retraining and snapshots;
- the evaluation workflow: Polymarket benchmark import, benchmark sets and markets, replay runs, and predictions.

It writes structured JSON logs with request ids. The judge service writes the same JSON shape and tags each line with the calling judgment's id, so one `judgmentId` finds a run in both services' logs.

### Judge service

The judge service exposes `GET /health`, `POST /judge`, `POST /plan` and `POST /calibrate`. `CASSANDRA_JUDGE_LLM=fake`, the default, gives a deterministic backend for tests and offline work.

### Web workspace

- **Events:** each event's latest probability and range, plus a forecast history chart. Outcomes can be recorded or corrected, and the resolution in force is shown with its source.
- **Judgments:**
  - the verdict readout and the pipeline stages;
  - how the forecast moved from prior to final;
  - judge cards with their per-model samples;
  - citations ranked by relevance, with diagnostics and the execution log kept collapsed.
- **Watchlists:** each page shows the watchlist's schedule, its next run and how the last run went. Discovery can also run from the page, and sources that failed are listed. Candidates can be seeded as events.
- **Evaluation:**
  - a comparison of baselines on the same paired sample;
  - a reliability chart;
  - scores by slice;
  - leakage warnings grouped by reason.
- **Calibration:** snapshot history, with the snapshot in use marked.
- **Runtime:** a filterable activity log across runs.

The visual identity is an "instrument" look: graph-paper ground, ink-blue text, and one magenta reserved for forecast probabilities. Fonts are self-hosted.

### Persistence

- **Operational tables:** `events`, `watchlists`, `candidate_events`, `evidence_items`, `judgments`, `judge_opinions`, `outcomes`, `calibration_snapshots`.
- **Evaluation tables:** `benchmark_markets`, `benchmark_price_snapshots`, `evaluation_runs`, `evaluation_predictions`, `evaluation_slice_metrics`.

There is no migration framework. Both SQL files are re-applied on every migrate and must stay idempotent.

## What is missing or partial

- **Discovery limits:**
  - On-demand discovery runs inside the request, so in `live` mode it waits for the slowest source. Scheduled runs use the queue.
  - A watchlist's cadence cannot be edited after creation, because no update endpoint exists.
  - In `live` mode every scheduled run makes paid search calls. `CASSANDRA_DISCOVERY_SCHEDULE=off` switches scheduling off.
- **No authentication.** In development the API listens on every network interface.
- **No OpenAPI document.** The contract in [api-reference.md](api-reference.md) is maintained by hand.
- **No browser end-to-end suite.** UI changes are checked with Testing Library plus manual Playwright MCP sessions.
- **No linter or formatter.** `pnpm lint` does nothing.
- **Small evaluation sample.** Calibration and evaluation results on the seeded data rest on a few dozen predictions and are not yet meaningful.

## Verification snapshot (2026-11-07)

| Check | Result |
| --- | --- |
| `pnpm test` | shared 10, web 46, API 165 tests pass (API against local Postgres and Redis, in `cassandra_test`) |
| `cd services/judge && uv run pytest` | 85 tests pass |
| `pnpm exec vitest run scripts/harness/real-e2e-support.test.ts` | 4 tests pass |
| `pnpm build` | passes |
| Browser check (Playwright MCP, fixture mode) | every route at 1440 and 390 px wide: no horizontal overflow, no console errors |
