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
- There is currently no auth layer or versioned prefix such as `/v1`.

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

Response shape:

- array of judgment records
- each record includes `id`, `eventId`, `status`, `verdictTrace`, `createdAt`, and `updatedAt`
- `verdictTrace` is `null` for queued or failed runs that do not have a stored trace yet

### `POST /judgments`

Creates and runs a judgment.

Request body:

```json
{
  "eventId": "event-id",
  "evaluationTime": "2026-10-11T12:00:00Z"
}
```

Notes:

- `evaluationTime` is optional; if omitted, the API uses the current time.
- In `fixture` mode, the API builds a local synthetic verdict trace.
- In `live` mode, the API calls the Python judge service at `JUDGE_BASE_URL`.

Success:

- status `201`
- response body is the stored judgment detail object

Errors:

- `400` with `error: "Invalid judgment input"`
- `404` with `error: "Event not found"` when `eventId` is unknown

### `POST /backtests/retrain`

Builds a new calibration snapshot from resolved outcomes and stored verdict traces.

Behavior:

- loads the most recent trace per resolved event
- sends `historicalTraces` and `resolvedOutcomes` to `POST /calibrate` on the judge service
- persists the returned calibration snapshot in Postgres

Success:

- status `201`
- response body is the persisted `CalibrationSnapshot`

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

Errors:

- `400` with `error: "Invalid benchmark import input"`
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

Success:

- status `201`
- response body is an `EvaluationRun`

Errors:

- `400` with `error: "Invalid evaluation run input"`
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

Success:

- status `200`
- response body is a `VerdictTrace`

Validation errors:

- `422` when required payload fields are missing or malformed

### `POST /calibrate`

Builds a calibration snapshot from historical traces and resolved outcomes.

Request body:

```json
{
  "historicalTraces": [],
  "resolvedOutcomes": []
}
```

Success:

- status `200`
- response body is a `CalibrationSnapshot`

## Core Response Types

### `VerdictTrace`

The main forecasting artifact includes:

- event and evaluation metadata
- prior, raw posterior, and final probability
- confidence interval
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
- `overallMetrics`
- `sliceResults`
- `replayFidelity`
- `leakageWarnings`
- `createdAt`

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
