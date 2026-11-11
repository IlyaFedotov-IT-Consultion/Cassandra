# Current Project Status

**Reviewed on:** 2026-11-11, on branch `feat/forecast-priors-and-calibration-gating`

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
2. **Retrieval:** official, government, community and web search, Perplexity, and Polymarket Gamma/CLOB, all run concurrently. A search result's source family comes from where it was published, not from which search found it. Stored evidence is immutable, so a trace's citations keep saying what they said.
3. **Relevance rating:** scores sources and keeps only the relevant ones.
4. **Prior:** the bound market's price; failing that, the reference class's observed base rate; failing that, a base rate the judge model estimates without evidence. Sources are not blended, and a market found only by search never sets the prior.
5. **Panel reasoning:** a multi-model judge ensemble, with a consistency guard that excludes samples whose label contradicts their probability. A judge whose model call fails abstains; the others still decide.
6. **Cross-examination:** runs when at least two judges had evidence.
7. **Aggregation:** log-odds pooling around the prior, as a weighted average over the judges that had evidence. The forecast's range is the spread across the ensemble's models.
8. **Calibration:** applies the approved snapshot. Until one is approved, forecasts are uncalibrated.

Calibration learns from two sources: live judgments whose events resolved, and replayed benchmark forecasts stored by evaluation runs. `pnpm harness:calibration` produces the second in bulk: it imports a larger benchmark set, replays it as one queued run, retrains and reports whether the new snapshot is worth approving. It costs money and runs nothing until `CALIBRATION_CONFIRM=yes` is set. `CALIBRATION_RUN_ID` resumes a failed run or waits for an existing one without re-importing. Refreshing a benchmark set retires old selection members but preserves their historical forecasts and prices. Market trust counts distinct markets and gives each market total fitting weight one across its horizons.

What is learned takes effect only through an approved calibration snapshot: the calibration map, the judge weights, the reference-class base rates, and how far a market price is trusted (fitted on resolved benchmark prices). A snapshot carries a held-out score for its calibration map, and approving one that does not beat uncalibrated forecasts needs an explicit override.

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
- **Watchlists:** each page shows the watchlist's schedule, its next run and how the last run went. Discovery can also run from the page, and sources that failed are listed. Live search results are grouped into candidates by headline. Candidates can be seeded as events.
- **Evaluation:**
  - a run's status and progress while it is queued or running, why it failed if it did, and a Resume action that retains stored forecasts;
  - a comparison of baselines on the same paired sample, with each baseline's Brier difference from Polymarket and an interval over markets;
  - a reliability chart;
  - scores by slice;
  - leakage warnings grouped by reason.
- **Calibration:** snapshot history, with the snapshot in use marked, what each snapshot was trained on, its held-out check and how far market prices are trusted.
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
- **Access control is opt-in.** The API listens on the loopback interface and serves only allowlisted browser origins, but an API key is required only when `CASSANDRA_API_KEY` is set. The judge service has no access control of its own.
- **Benchmark re-import needed.** Replay cutoffs now count back from each market's scheduled end date. Price snapshots imported before that change sit at the old, resolution-anchored cutoffs.
- **No OpenAPI document.** The contract in [api-reference.md](api-reference.md) is maintained by hand.
- **No browser end-to-end suite.** UI changes are checked with Testing Library plus manual Playwright MCP sessions.
- **No linter or formatter.** `pnpm lint` does nothing.
- **Replay retrieval is present-day search.** A replay searches today's web and keeps results dated before the cutoff, so its forecasts are somewhat better informed than a live forecast was. Calibration trained on replays inherits that; `includeReplay: false` trains on live judgments only.
- **No calibration data yet.** A calibration map needs 20 resolved markets or events. None has been produced in this checkout: `pnpm harness:calibration` has not been run, because it costs money.

## Verification snapshot (2026-11-11)

| Check | Result |
| --- | --- |
| `pnpm test` | shared 10, web 87, API 274 tests pass (API against local Postgres and Redis, in `cassandra_test`) |
| `cd services/judge && uv run pytest` | 149 tests pass |
| `pnpm exec vitest run scripts/harness/real-e2e-support.test.ts scripts/harness/calibration-cycle.test.ts` | 12 tests pass |
| `pnpm build` | passes |
| Browser check (Playwright MCP, intercepted fixture responses) | evaluation run queued, running, failed and completed at 1440 and 390 px; polling transitions and keyboard Resume action pass; no horizontal page overflow, console errors or failed requests |
| Redis queue smoke | synthetic failure stays failed without automatic retry; explicit requeue completes; active jobs drain before shared connections close; shutdown exits cleanly |
| Generated judge schemas | regeneration matches `models_generated.py` |
