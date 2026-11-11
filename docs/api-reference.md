# API Reference

This document describes the current HTTP API exposed by the Cassandra prototype as implemented in the repository today.

## Services

### Orchestration API

- Default base URL: `http://localhost:3000`
- Implementation: [apps/api/src/app.ts](/Users/ilya/Documents/Cassandra/apps/api/src/app.ts)

### Judge service

- Default base URL: `http://localhost:8000`
- Implementation: [services/judge/app/api.py](/Users/ilya/Documents/Cassandra/services/judge/app/api.py)

## Conventions

- Request and response bodies are JSON.
- Shared payload definitions originate in [packages/shared/src/schemas.ts](/Users/ilya/Documents/Cassandra/packages/shared/src/schemas.ts).
- The Fastify API usually returns validation errors as:

```json
{
  "error": "Invalid ... input",
  "issues": []
}
```

- The FastAPI judge service uses its default validation behavior and returns `422` for malformed payloads.
- There is no versioned prefix such as `/v1`.
- Access:
  - The API listens on `API_HOST` (default `127.0.0.1`).
  - A request with an `Origin` header is served only when that origin is listed in `CASSANDRA_CORS_ORIGINS`; any other origin gets `403`, preflight included. Requests without an `Origin` (curl, the harness) are served.
  - When `CASSANDRA_API_KEY` is set, every route except `GET /health` and `GET /ready` requires it as `x-api-key: <key>` or `Authorization: Bearer <key>`, and answers `401` without it. With no key configured the API is open to whoever can reach it.
- The API accepts an optional `x-request-id` header. If it is not provided, the API generates one internally.
- The API emits structured JSON logs for request lifecycle, readiness failures, evidence collection, and judgment execution events.
- The judge service logs JSON lines in the same shape (`level`, `time`, `service`, `scope`, `event`, `message`), with `service: "cassandra-judge"`. Both services read `LOG_LEVEL`.
- On every judge call the API sends `x-request-id` (new for each call), `x-cassandra-event-id` and, for a judgment run, `x-cassandra-judgment-id`. The judge writes them as `requestId`, `eventId` and `judgmentId` on every log line of that call, and echoes `x-request-id` in the response. A failed judge call's error names that request id.

## Common Shared Shapes

### EventInput

```json
{
  "question": "Will Example Corp launch Product X by 2026-12-31?",
  "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
  "deadline": "2026-12-31T23:59:59Z",
  "entities": ["Example Corp", "Product X"],
  "referenceClass": "product_launch",
  "marketSymbols": ["EXMPL"],
  "polymarketMarketId": "poly-1"
}
```

### WatchlistInput

```json
{
  "name": "Biotech approvals",
  "keywords": ["FDA", "approval"],
  "jurisdictions": ["US"],
  "cadence": "daily",
  "sourceToggles": {
    "official": true,
    "government": true
  }
}
```

### OutcomeInput

```json
{
  "eventId": "event-id",
  "resolvedValue": true,
  "resolvedAt": "2026-12-31T23:59:59Z",
  "resolutionSourceUrl": "https://example.com/resolution"
}
```

## Orchestration API Endpoints

### `GET /health`

Returns a lightweight liveness check.

Response:

```json
{
  "status": "ok"
}
```

### `GET /ready`

Runs readiness checks for Postgres and Redis when the app is started with those dependencies wired in.

Success response:

```json
{
  "status": "ready"
}
```

Failure response:

```json
{
  "status": "not_ready",
  "error": "..."
}
```

### `GET /events`

Returns all persisted events ordered by newest first.

Response items include:

- `id`
- `question`
- `resolutionCriteria`
- `deadline`
- `status`
- `entities`
- `referenceClass`
- `marketSymbols`
- `polymarketMarketId`
- `createdAt`
- `updatedAt`

### `GET /events/:id`

Returns a single event record.

Errors:

- `400` if `id` is missing
- `404` if the event does not exist

### `POST /events`

Creates a new event from `EventInput`.

Request body: `EventInput`

Success:

- status `201`
- response body is the persisted event record

Validation errors:

- `400` with `error: "Invalid event input"`

### `GET /watchlists`

Returns all persisted watchlists ordered by newest first.

Response items include:

- `id`
- `name`
- `keywords`
- `jurisdictions`
- `cadence`
- `sourceToggles`
- `status`
- `createdAt`
- `updatedAt`
- `lastDiscovery`: `{ ranAt, trigger, candidateCount, failedProviders }` for the latest discovery run, or `null` if discovery has never run. `trigger` is `"manual"` or `"scheduled"`.

### `GET /watchlists/:id`

Returns a single persisted watchlist.

Errors:

- `400` if `id` is missing
- `404` if the watchlist does not exist

### `GET /watchlists/:id/schedule`

Describes when discovery runs for the watchlist. Response: `{ cadence, intervalMs, nextRunAt }`.

The cadences `hourly`, `daily` and `weekly` are scheduled. Any other value, including `manual`, gets `intervalMs: null` and runs only on demand.

`nextRunAt` is `null` when nothing is scheduled. That includes a scheduled cadence while `CASSANDRA_DISCOVERY_SCHEDULE=off`.

How scheduling works:
- **Where it runs:** the API process runs scheduled discovery on a BullMQ queue (`watchlist-discovery`), one run at a time, and records each run in `lastDiscovery`.
- **Timing:** creating a watchlist schedules its first run one interval out. Discovery never starts on creation.
- **Restarts:** on start the API syncs every watchlist's schedule. An unchanged schedule keeps its next run, so restarts do not trigger extra runs.
- **Deleted watchlists:** a scheduled run for a watchlist that no longer exists removes that schedule.

Errors:

- `404` if the watchlist does not exist

### `GET /watchlists/:id/candidates`

Returns candidate events linked to a watchlist.

Response items include:

- `id`
- `watchlistId`
- `title`
- `description`
- `supportingEvidenceIds`
- `clusterKey`
- `promotionStatus`
- `candidateSignature`

Errors:

- `400` if `id` is missing
- `404` if the watchlist does not exist

### `POST /watchlists/:id/discover`

Runs candidate discovery for the watchlist now and returns the result. The run works like this:

- It collects evidence from the configured providers, using the watchlist keywords as the query, in the current `CASSANDRA_ADAPTER_MODE`. In `live` mode that means paid search calls.
- It skips the sources the watchlist has switched off in `sourceToggles`. An absent toggle counts as on, and web search and Perplexity have no toggle, so they always run. The toggles map to providers like this:
  - `official`: `officialSearch`
  - `government`: `governmentSearch`
  - `community`: `communitySearch`
  - `markets`: `marketProvider`
  - `predictionMarkets`: `polymarketGamma` and `polymarketClob`
- It clusters the evidence into candidates. Candidates already stored are upserted by signature, so a rerun keeps their promotion status.
  - An item with entities of its own is identified by them: the entities, the action (launch, approve, delay, reject, announce) and its polarity.
  - An item without any, which is what a live search result is, or whose only entities are the watchlist's keywords, is identified by its headline. It joins a candidate whose headline shares most of its words, at least two of them not watchlist keywords; that candidate's `candidateSignature.topic` holds the headline words it was first stored with.
- It runs inside the request, with no queue, because it never calls the judge.
- It records the run on the watchlist as `lastDiscovery`, with `trigger: "manual"`.

No request body.

Success: status `200`, with a `WatchlistDiscoveryResult` body:

- `candidates`: the candidates found by this run, in the same shape as `GET /watchlists/:id/candidates`.
- `failedProviders`: `{ providerName, error }[]`. A failing provider is reported here and logged as `watchlist_discovery_provider_failed`. It does not fail the run.

Errors:

- `404` if the watchlist does not exist

### `POST /watchlists`

Creates a watchlist from `WatchlistInput`.

Request body: `WatchlistInput`

Success:

- status `201`
- response body is the persisted watchlist

Validation errors:

- `400` with `error: "Invalid watchlist input"`

### `POST /outcomes`

Creates an outcome record for a resolved event.

Request body: `OutcomeInput`

Success:

- status `201`
- response body includes `id`, the original outcome fields, and `createdAt`

Validation errors:

- `400` with `error: "Invalid outcome input"`

### `GET /outcomes`

Lists recorded outcomes, newest first.

Query parameters:

- `eventId` (optional, UUID): only outcomes for that event. An event can have several outcomes; the first one returned is the latest and acts as a correction of earlier ones.

Success: status `200` with `OutcomeRecord[]` items. Each item holds `id`, `eventId`, `resolvedValue`, `resolvedAt`, `resolutionSourceUrl` and `createdAt`.

Errors:

- `400` with `error: "Invalid outcome query"` for a malformed `eventId` or an unknown parameter

### `GET /judgments/:id`

Fetches a stored judgment plus its normalized judge opinions.

Response shape:

- `id`
- `eventId`
- `status`
- `verdictTrace`
- `createdAt`
- `updatedAt`
- `judgeOpinions`

Errors:

- `400` if `id` is missing
- `404` if the judgment does not exist

### `GET /judgments`

Lists stored judgment runs in reverse chronological order.

Query parameters:

- `eventId` optional; when supplied, only judgments for that event are returned

Response shape:

- array of judgment records
- each record includes `id`, `eventId`, `status`, `verdictTrace`, `createdAt`, and `updatedAt`
- `verdictTrace` is `null` for queued or failed runs that do not have a stored trace yet

### `POST /judgments`

Creates and enqueues a judgment run.

Request body:

```json
{
  "eventId": "event-id",
  "evaluationTime": "2026-10-11T12:00:00Z"
}
```

Notes:

- `evaluationTime` is optional; if omitted, the API uses the time the judgment was queued. A retried run keeps that time, so its query plan, evidence and judge output come from the caches where they were already paid for.
- A failed run is retried once, and only when the failure is transient: the judge service was overloaded, unreachable or timed out, or every evidence provider failed. Other failures end the run at once.
- The API persists a judgment with status `queued`, enqueues a BullMQ job in Redis, and returns immediately.
- The worker later stores a terminal status of `completed`, `insufficient_evidence`, or `failed`.
- In both `fixture` and `live` modes, the forecasting trace is produced by the Python judge service at `JUDGE_BASE_URL`.
- When live citation coverage is too weak, the API still calls the judge service, with `priorOnly: true`, and stores the returned prior-only trace as `insufficient_evidence`.
- Evidence providers run concurrently, so retrieval takes as long as the slowest source.
- A live search result's `sourceFamily` comes from where it was published, not from which search found it: government domains are `government`, Reddit and X posts are `community`, a press wire or a domain named after one of the event's entities is `official`, and everything else is `web`. `metadata.queryIntent` records what the search was looking for.
- The panel reads at most 18 evidence items (6 per judge). Slots that a judge with little evidence leaves unused go to judges that have more candidates.
- Stored evidence is immutable. A page whose content changed, or a new market quote, is stored as a new row with a new id, so the evidence a past trace cites keeps saying what it said then. Unchanged content reuses its row.
- Before retrieval the API asks the judge service to plan up to 3 sub-question search queries (`POST /plan`); each search provider runs its own query plus up to 2 planned queries. Planning failures fall back to the templated queries.
- `verdictTrace.pipelineStages` records every stage in order: `query_planning`, `retrieval`, `relevance_rating`, `prior`, `panel_reasoning`, `cross_examination`, `aggregation`, `calibration`, each with `status` (`completed`, `skipped`, `failed`) and `details`. The execution log has a `planning` entry.
- The judgment uses the approved calibration snapshot. While none is approved it uses the identity baseline, whose id is `baseline-identity`.
- In `fixture` mode, evidence providers still use canned fixture payloads and the judge service normally runs with its fake LLM backend.

Success:

- status `202`
- response body is the queued judgment record
- fetch `GET /judgments/:id` to observe terminal completion

Errors:

- `400` with `error: "Invalid judgment input"`
- `404` with `error: "Event not found"` when `eventId` is unknown
- `409` when live mode is requested without a configured authoritative search provider

### `POST /backtests/retrain`

Builds a new calibration snapshot from resolved outcomes and stored verdict traces.

Behavior:

- loads, per resolved event, the latest trace evaluated before the resolution, separately for completed and prior-only judgments
- loads benchmark market prices recorded before each market resolved, with how the market resolved
- sends `historicalTraces`, `resolvedOutcomes` and `marketPricePairs` to `POST /calibrate` on the judge service
- persists the returned calibration snapshot in Postgres, unapproved
- in `fixture` mode nothing is fitted: the stored snapshot records the sample size and keeps `calibrationParams.method: "identity"`

A new snapshot changes no forecast until it is approved.

Success:

- status `201`
- response body is the persisted `CalibrationSnapshot`

### `GET /backtests/calibration-snapshots`

Lists stored calibration snapshot summaries in reverse chronological order.

Each item includes:

- `id`
- `createdAt`
- `trainingWindow`
- `metrics`
- `weightRegime`
- `resolvedOutcomeCount`
- `approved`

### `GET /backtests/calibration-snapshots/:id`

Fetches a single stored calibration snapshot.

Errors:

- `400` if `id` is missing
- `404` with `error: "Calibration snapshot not found"`

### `POST /backtests/calibration-snapshots/:id/approve`

Makes a snapshot the one judgments use and un-approves every other snapshot.

Request body (optional): `{ "force": true }`.

A snapshot whose `calibrationParams.method` is not `identity` is approved only when `metrics.heldOut.improves` is `true`, that is, when its calibration map scored a better Brier than uncalibrated forecasts on held-out data. `force` approves it regardless.

Success: `200` with the approved `CalibrationSnapshot`.

Errors:

- `400` with `error: "Invalid approval input"`
- `404` with `error: "Calibration snapshot not found"`
- `409` when the held-out check is missing or failed and `force` was not sent; `error` gives the scores

### `POST /evaluation/benchmarks/import/polymarket`

Imports resolved Polymarket benchmark markets into Postgres.

Request body:

```json
{
  "benchmarkSetId": "custom-benchmark-set"
}
```

Fields:

- `benchmarkSetId` is optional
- when omitted, imports use the default benchmark set `polymarket_recent_resolved`

Success response:

```json
{
  "imported": 1,
  "markets": []
}
```

Notes:

- data is fetched from `POLYMARKET_GAMMA_URL`
- imported rows are stored in `benchmark_markets`
- imported markets carry their `benchmarkSetId`
- this endpoint requires `CASSANDRA_ADAPTER_MODE=live`

Errors:

- `400` with `error: "Invalid benchmark import input"`
- `409` with `error: "Real evaluations require CASSANDRA_ADAPTER_MODE=live"`
- `409` with `error: "Benchmark market ... already belongs to benchmark set ..."`

### `GET /evaluation/benchmark-sets`

Lists available benchmark sets that can be used with evaluation runs.

Success response:

```json
[
  {
    "benchmarkSetId": "polymarket_recent_resolved",
    "marketCount": 42,
    "earliestResolvedAt": "2026-11-15T00:00:00.000Z",
    "latestResolvedAt": "2026-12-31T23:59:59.000Z",
    "themes": ["crypto", "politics", "technology"]
  }
]
```

Response fields:

- `benchmarkSetId` is the identifier accepted by `POST /evaluation/runs`
- `marketCount` is the number of imported markets in the set
- `earliestResolvedAt` and `latestResolvedAt` bound the resolved-market window in the set
- `themes` is the deduplicated sorted list of themes represented in the set

### `GET /evaluation/benchmark-sets/:benchmarkSetId/markets`

Lists benchmark markets inside a benchmark set.

Errors:

- `400` if `benchmarkSetId` is missing
- `404` with `error: "Benchmark set not found"`

### `POST /evaluation/runs`

Creates and executes a historical evaluation run.

Request body:

```json
{
  "benchmarkSetId": "polymarket_recent_resolved",
  "benchmarkMarketIds": ["market-1"],
  "baselines": [
    "base_rate_only",
    "polymarket_only",
    "model_without_polymarket",
    "model_with_polymarket"
  ]
}
```

Fields:

- `benchmarkSetId` is required
- `benchmarkMarketIds` is optional and scopes the run to specific imported benchmarks
- `baselines` is optional and defaults inside the evaluation flow when omitted
- this endpoint requires `CASSANDRA_ADAPTER_MODE=live`
- each market is replayed at 30 days, 7 days, 1 day and 6 hours before its scheduled `endDate` (before `resolvedAt` when the end date is unknown). Cutoffs at or after the market's resolution are skipped, and `leakageWarnings` names the skipped horizons
- price snapshots are stored per cutoff at import, so re-import the benchmark set before running against markets imported under the earlier, resolution-anchored cutoffs

Success:

- status `201`
- response body is an `EvaluationRun`

Errors:

- `400` with `error: "Invalid evaluation run input"`
- `409` with `error: "Real evaluations require CASSANDRA_ADAPTER_MODE=live"`
- `404` with `error: "No benchmark markets available for evaluation"`
- `404` with `error: "Benchmark markets not found: ..."`

### `GET /evaluation/runs/:id`

Fetches a previously stored evaluation run.

Success:

- status `200`
- response body is an `EvaluationRun`

Errors:

- `400` if `id` is missing
- `404` with `error: "Evaluation run not found"`

### `GET /evaluation/runs`

Lists stored evaluation runs in reverse chronological order.

Each item includes:

- `id`
- `benchmarkSetId`
- `overallMetrics`
- `replayFidelity`
- `createdAt`

### `GET /evaluation/runs/:id/predictions`

Lists persisted prediction rows for an evaluation run.

Errors:

- `400` if `id` is missing
- `404` with `error: "Evaluation run not found"`

## Judge Service Endpoints

### `GET /health`

Returns a liveness response.

Response:

```json
{
  "status": "ok"
}
```

### `POST /judge`

Produces a `VerdictTrace` for a supplied event, evidence set, and calibration snapshot.

Request body:

```json
{
  "event": {
    "question": "Will Example Corp launch Product X by 2026-12-31?",
    "resolutionCriteria": "Counts only if Example Corp posts a general availability announcement on its official site.",
    "deadline": "2026-12-31T23:59:59Z",
    "entities": ["Example Corp", "Product X"],
    "referenceClass": "product_launch",
    "marketSymbols": ["EXMPL"]
  },
  "evaluationTime": "2026-10-11T12:00:00Z",
  "priorOnly": false,
  "evidence": [],
  "calibrationSnapshot": {
    "id": "snapshot-1",
    "createdAt": "2026-10-01T00:00:00Z",
    "trainingWindow": "all_time",
    "judgeWeights": {},
    "baseRateParams": {},
    "marketPriorParams": {},
    "calibrationParams": {
      "method": "identity"
    },
    "onlineLearningParams": {},
    "metrics": {},
    "weightRegime": "cold_start",
    "resolvedOutcomeCount": 0,
    "approved": false
  }
}
```

Notes:

- `priorOnly` (optional, default `false`): skip the judge panel and return an `insufficient_evidence` trace that reports the prior only. The panel and the cross-examiner are not called.
- The prior comes from the first source available, and sources are never blended:
  1. **Bound market.** The most liquid `prediction_market` evidence item that carries a Yes probability (`probability`, `yesPrice`, `price` for a Yes token, or `outcomePrices` with `outcomes`). Items with `metadata.matchedBy: "search"` are related markets, not this question, and never set the prior; traditional `market` quotes are never treated as probabilities. The price is mapped through the snapshot's `marketPriorParams` (`trustSlope`, `trustIntercept`), which default to using the price as it is. Liquidity and spread do not discount it.
  2. **Reference class.** The observed base rate, once the event's `referenceClass` has at least `minimumSample` resolved events in the snapshot.
  3. **Estimated base rate.** The judge model's outside-view estimate for the question, made without evidence and bounded to 0.02–0.98. With an ensemble it is the median in log-odds.
  4. **Uninformed.** 0.5, when no estimate is available.
- The `prior` pipeline stage records the `source` (`market`, `reference_class`, `estimated_base_rate`, `uninformed`), the `probability`, the market price and liquidity, `relatedMarketsIgnored`, and for an estimate its `rationale`, `referenceClass` and per-model `samples`. Its status is `failed` when the estimate failed and the prior fell back to 0.5.
- A panel judge with no evidence for its source families is neutral and does not call the LLM. The pool is a weighted average over the judges that had evidence: a judge without evidence holds no weight, so it does not scale the others down.
- A judge whose model call fails abstains in the same way, with the failure in its `warnings` and in the `panel_reasoning` stage's `failedJudges`. The request fails with `502` only when every judge that had evidence failed.
- `confidenceLow` and `confidenceHigh` say how much the forecast depends on which models were asked (`uncertaintyMethod: "model_spread"`): the ensemble's models are redrawn with replacement, the per-judge and base-rate medians retaken, and the result pooled as the forecast was, 500 times; the range is the middle 90%. When nothing was answered by more than one model there is no spread to measure, and the range is a fixed band of one log-odds unit either side (`"none"`). Traces from before this change may say `"bootstrap"`, a resampling of the panel's judges.
- The caller's `x-cassandra-timeout-ms` header sets the request's model budget: the judge stops starting model calls at 90% of it. Without the header, `JUDGE_REQUEST_BUDGET_SECONDS` applies (default 330).
- Relevance stage: before the panel runs, every non-market evidence item is rated 1–6 for the question by the utility model, items below 4 are dropped, and the rest are passed to the judges with question-focused summaries (the original snippet is kept in `metadata.originalSummary`). If rating rejected evidence and fewer than 2 relevant items remain, the trace is prior-only with status `insufficient_evidence`. A rating failure falls back to unfiltered evidence.
- Ensemble consistency guard: a sample whose moderate/strong label contradicts its own probability (for example `strong_against` with p ≥ 0.75) is marked `excluded` in `samples` and left out of the median, unless every sample is incoherent.
- Judge prompts include the `evaluationTime` as the as-of date.
- With `OPENROUTER_JUDGE_MODELS` set, each panel judge is an ensemble: its `logBayesFactor` is the median of the members' log Bayes factors (it can fall between labels; `evidenceStrength` is the nearest label), its `probability` is the median in log-odds, and the member samples are listed in `weightBreakdown[].details.samples`. `modelVersion` names the models used.

Success:

- status `200`
- response body is a `VerdictTrace`

Validation errors:

- `422` when required payload fields are missing or malformed

### `POST /plan`

Pipeline stage 1: decomposes the question into sub-questions with one search query each, using the utility model (`OPENROUTER_UTILITY_MODEL`).

Request body: `{ "event": EventInput, "evaluationTime": "...", "maxQueries": 3 }` (`maxQueries` 1–8, default 4).

Success: `200` with `{ "subQuestions": [...], "queries": [...], "model": "..." }`. Queries are whitespace-normalised, de-duplicated (case-insensitive) and never repeat the question itself. `502` when the planning model fails.

### `POST /calibrate`

Builds a calibration snapshot from historical traces and resolved outcomes.

- One training pair per event: its latest completed trace evaluated before the outcome's `resolvedAt`. Prior-only (`insufficient_evidence`) traces do not train the calibration map or the judge weights; their events still count toward reference-class base rates.
- The fit uses each trace's `preCalibrationProbability`. Older calibrated traces without it are skipped.
- `resolvedOutcomeCount` and the regime count matched training pairs.
- `warming` fits Platt scaling (penalised toward identity); `steady` fits isotonic regression (pool adjacent violators).
- `metrics.heldOut` reports a 5-fold cross-validation of the calibration map: `brierIdentity`, `brierCalibrated`, `logLossIdentity`, `logLossCalibrated`, `folds`, `sampleSize` and `improves`. It is absent in `cold_start`, where the map is the identity.
- `marketPriorParams` is fitted from `marketPricePairs`: a Platt fit of outcomes on market log-odds, stored as `trustSlope`, `trustIntercept`, `fitted` and `sampleSize`. With fewer than 40 pairs, or only one kind of outcome, it stays at slope 1 and intercept 0.

Request body:

```json
{
  "historicalTraces": [],
  "resolvedOutcomes": [],
  "marketPricePairs": [{ "price": 0.7, "outcome": true }]
}
```

Success:

- status `200`
- response body is a `CalibrationSnapshot`

## Core Response Types

### `VerdictTrace`

The main forecasting artifact includes:

- event and evaluation metadata
- prior, raw posterior (before disagreement shrinkage), `preCalibrationProbability` (after shrinkage, before calibration), and final probability
- confidence range and `uncertaintyMethod` (`model_spread`, `none`, or the earlier `bootstrap`)
- judge opinions and weight breakdown
- dependency matrix and disagreement shrinkage
- conflicts and missing evidence
- citations
- model, weight, and calibration version stamps

### `EvaluationRun`

Evaluation run responses include:

- `id`
- `benchmarkSetId`
- `cutoffs`
- `baselines`
- `overallMetrics`: `byBaseline` summaries over every prediction each baseline produced, plus `paired`, which restricts every baseline to the market-cutoff pairs all of them scored. Each summary includes `brierScore`, `logLoss`, `averageAbsoluteError`, `expectedCalibrationError`, `winRateVsPolymarket`, and `sampleSize`.
- `sliceResults`
- `replayFidelity`
- `leakageWarnings`
- `createdAt`

Benchmark markets carry `endDate`, the scheduled end, alongside `resolvedAt`, the close time. Replay uses `endDate` as the event deadline and as the anchor for its cutoffs.

### `BenchmarkSetSummary`

Benchmark set summary responses include:

- `benchmarkSetId`
- `marketCount`
- `earliestResolvedAt`
- `latestResolvedAt`
- `themes`

### `CalibrationSnapshot`

Calibration snapshots include:

- `id`
- `createdAt`
- `trainingWindow`
- `judgeWeights`
- `baseRateParams`
- `marketPriorParams`
- `calibrationParams`
- `onlineLearningParams`
- `metrics`
- `weightRegime`
- `resolvedOutcomeCount`
- `approved`
