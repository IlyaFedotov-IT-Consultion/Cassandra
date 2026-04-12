# Structured Logging Design

**Status:** Draft v1
**Date:** 2026-04-11
**Product Codename:** Cassandra
**Scope:** Backend/server-side processes only

## 1. Summary

Cassandra currently has fragmented logging. The TypeScript API disables Fastify logging, the Python judge service uses module-level `logging.getLogger()` calls with no centralized JSON formatter, and server-side scripts print human-oriented console output. This makes it difficult to correlate requests across services, filter logs by machine-stable events, or ship logs to a collector later without reworking every runtime.

This design introduces a contract-first structured logging system for all backend/server-side processes. The center of the design is a shared log schema and field conventions, not a single runtime library, because the repo is intentionally split across TypeScript and Python. Every backend process emits newline-delimited JSON to `stdout` or `stderr`, and each runtime implements a thin adapter that normalizes log entries to the same contract.

The phase-1 goal is to make local and containerized logs consistent, machine-readable, and correlation-friendly while preserving a low-friction path to future ingestion by OpenTelemetry, Loki, Elastic, Datadog, or another collector.

## 2. Goals

- Define one canonical structured-log contract for backend/server-side Cassandra processes.
- Emit newline-delimited JSON to `stdout`/`stderr` in the API, judge service, and server-side scripts.
- Support cross-service request correlation through a propagated request ID.
- Normalize error serialization so failures are machine-readable and grep-friendly.
- Keep adapters thin and runtime-native rather than forcing a cross-language shared library.
- Make future collector integration possible without redesigning log shape.

## 3. Non-Goals

- No browser/client-side logging standardization in this phase.
- No log collector, dashboard, or hosted observability backend in this phase.
- No distributed tracing implementation beyond stable correlation IDs.
- No promise that every internal debug statement exists on day one; the focus is a usable, stable baseline.
- No storage of logs in Postgres or Redis.

## 4. Scope

Phase 1 applies to:

- `apps/api`
- `services/judge`
- server-side scripts such as `scripts/harness/real-e2e.mts`

Phase 1 does not apply to:

- `apps/web`
- browser console output
- third-party infrastructure logs from Postgres, Redis, Docker, or external APIs

## 5. Design Principles

### 5.1 Contract first

The canonical source of truth is the schema and field naming convention. Each runtime adapter must conform to the contract even if the underlying library differs.

### 5.2 JSON to stdout

Every backend process writes one JSON object per line to `stdout` for normal logs and `stderr` for fatal process-level failures when appropriate. This matches container best practices and keeps local development simple.

### 5.3 Stable event names

Humans read `message`; machines filter on `event`. Event names must be stable, dotted, and specific enough to drive filtering without parsing free text.

### 5.4 Bound context

Request and job metadata should be bound once at the boundary of a request or operation, then inherited by downstream logs rather than manually copied everywhere.

### 5.5 Safe by default

Secrets, tokens, raw auth headers, and unbounded request/response payloads must not be logged by default. Structured logging is only useful if it is safe to leave on.

## 6. Canonical Log Contract

Every log entry must be a JSON object with this base shape:

```json
{
  "timestamp": "2026-04-11T19:22:41.103Z",
  "level": "info",
  "service": "api",
  "environment": "development",
  "message": "request completed",
  "event": "http.request.completed",
  "requestId": "req_01hrm8r6k6m4x0j2h7q0w4x2af",
  "traceId": null,
  "operation": "GET /health",
  "durationMs": 3,
  "error": null,
  "context": {
    "method": "GET",
    "path": "/health",
    "statusCode": 200
  }
}
```

### 6.1 Required fields

- `timestamp`
  - UTC ISO-8601 timestamp with millisecond precision.
- `level`
  - One of `debug`, `info`, `warn`, `error`.
- `service`
  - Stable service identifier such as `api`, `judge`, or `harness`.
- `environment`
  - Runtime environment label such as `development`, `test`, or `production`.
- `message`
  - Human-readable summary.
- `event`
  - Machine-stable event name.
- `context`
  - Object. May be empty, but must exist.

### 6.2 Standard optional fields

- `requestId`
  - Correlation ID for HTTP request flows. Null when not applicable.
- `traceId`
  - Reserved for future trace integration. Null in phase 1 unless a runtime already has one.
- `operation`
  - Boundary operation label such as `POST /judgments`, `runScenario`, or `openrouter.chat`.
- `durationMs`
  - Numeric duration when a log reports a completed timed operation.
- `error`
  - Normalized error object when a failure or degraded path is logged.

### 6.3 Normalized error shape

When present, `error` must use this structure:

```json
{
  "name": "Error",
  "message": "timed out waiting for judge service",
  "stack": "Error: timed out ...",
  "code": "ETIMEDOUT"
}
```

Rules:

- `name` and `message` are always included.
- `stack` is included in non-production environments and may be omitted or truncated later if needed.
- `code` is optional.
- Additional machine-safe fields may be added under `error`, but raw provider payloads must not be copied wholesale.

### 6.4 Context rules

`context` is the only intentionally flexible field. It should hold structured metadata such as:

- HTTP metadata: `method`, `path`, `statusCode`, `remoteAddress`
- Job metadata: `judgmentId`, `eventId`, `runId`, `scenario`
- Integration metadata: `provider`, `model`, `attempt`, `maxAttempts`, `statusCode`

Rules:

- Use primitive values, arrays, or shallow objects.
- Avoid high-cardinality junk such as raw stack traces in `context`; use `error` instead.
- Avoid huge payloads. Context should explain the event, not mirror the full request/response body.

## 7. Event Naming Conventions

Event names must be dotted, lowercase, and stable over time.

Recommended categories:

- HTTP lifecycle
  - `http.request.received`
  - `http.request.completed`
  - `http.request.failed`
- Service lifecycle
  - `service.starting`
  - `service.ready`
  - `service.stopping`
  - `service.fatal`
- Domain operations
  - `judgment.enqueued`
  - `judgment.worker.started`
  - `judgment.worker.completed`
  - `judge.trace.completed`
- External integrations
  - `llm.openrouter.request`
  - `llm.openrouter.timeout`
  - `llm.openrouter.retryable_status`
  - `llm.openrouter.failed`
- Script and harness operations
  - `harness.started`
  - `harness.scenario.started`
  - `harness.scenario.completed`
  - `harness.failed`

Rules:

- `message` can change for readability; `event` should rarely change.
- Do not encode dynamic values into the event name.
- If two logs need different filtering semantics, they should use different events even if the messages are similar.

## 8. Correlation Model

### 8.1 Request ID

The request ID is the primary phase-1 correlation key.

Rules:

- The API accepts an inbound `x-request-id` header if present.
- If absent, the API generates one at request ingress.
- The API includes `x-request-id` on responses.
- The API forwards `x-request-id` to the judge service on outbound HTTP calls.
- The judge service accepts and binds `x-request-id` in request middleware.
- All request-scope logs emitted during handling of that request must include the same `requestId`.

### 8.2 Operation IDs for non-request work

Some work is not tied to an inbound request, such as background jobs or harness scenarios. Those flows should use operation-specific identifiers in `context`, for example:

- `judgmentId`
- `eventId`
- `runId`
- `scenario`

If a background job originates from a request, it should preserve the originating `requestId` when practical.

### 8.3 Trace ID

`traceId` remains reserved for future tracing integration. In phase 1 it is present but usually null, which keeps the contract forward-compatible without forcing a tracing stack now.

## 9. Runtime Architecture

### 9.1 TypeScript services and scripts

TypeScript code should use a shared helper module that:

- sets default service/environment metadata
- normalizes error objects
- adds or merges `context`
- supports child/bound loggers for request or operation scope
- writes one JSON object per line

For `apps/api`, Fastify logging should be enabled and backed by the structured logger instead of `logger: false`. Route handlers, worker launch points, and integration boundaries should use bound logger instances rather than raw `console.*`.

For scripts like `scripts/harness/real-e2e.mts`, the helper should expose a small runtime-neutral interface so script logs match service logs without requiring Fastify.

### 9.2 Python judge service

The judge service should use a single logging bootstrap that:

- configures root logging once at process startup
- formats log records as JSON lines
- injects service/environment defaults
- supports bound request context using a context variable or equivalent mechanism
- normalizes exception logging into the shared `error` shape

Application modules should continue using runtime-native logger acquisition, but emission should flow through the shared formatter and context binding layer.

### 9.3 Why the center is the contract, not the code

`packages/shared` is TypeScript-only today, while the judge service is Python. A shared TS runtime package cannot be the full answer. The shared asset is therefore:

- the documented schema
- field names
- event naming rules
- error normalization rules
- propagation conventions

Thin runtime adapters in each language implement that contract.

## 10. Boundary Logging Strategy

### 10.1 API service

The API should log at these boundaries:

- process start and listen success/failure
- HTTP request received/completed/failed
- readiness and health failures when dependencies are unavailable
- background worker enqueue/start/complete/fail
- outbound judge-service HTTP requests at a coarse level

Example API completion log:

```json
{
  "timestamp": "2026-04-11T19:22:41.103Z",
  "level": "info",
  "service": "api",
  "environment": "development",
  "message": "request completed",
  "event": "http.request.completed",
  "requestId": "req_123",
  "traceId": null,
  "operation": "POST /judgments",
  "durationMs": 18,
  "error": null,
  "context": {
    "method": "POST",
    "path": "/judgments",
    "statusCode": 202
  }
}
```

### 10.2 Judge service

The judge service should log at these boundaries:

- process start
- inbound HTTP request received/completed/failed
- judge evaluation started/completed
- calibration started/completed
- OpenRouter retries, timeouts, retryable statuses, and terminal failures

Example degraded retry log:

```json
{
  "timestamp": "2026-04-11T19:23:08.441Z",
  "level": "warn",
  "service": "judge",
  "environment": "development",
  "message": "openrouter timeout",
  "event": "llm.openrouter.timeout",
  "requestId": "req_123",
  "traceId": null,
  "operation": "openrouter.chat",
  "durationMs": null,
  "error": {
    "name": "TimeoutException",
    "message": "The read operation timed out",
    "stack": "Traceback ..."
  },
  "context": {
    "provider": "openrouter",
    "model": "openai/gpt-5",
    "attempt": 1,
    "maxAttempts": 3
  }
}
```

### 10.3 Harness and server-side scripts

Server-side scripts should log major lifecycle steps as structured events:

- run started/completed/failed
- per-scenario started/completed
- API readiness waits or timeouts
- artifact writing

Scripts may still print a final concise human summary, but the canonical output during execution should be structured logs.

## 11. Redaction And Safety Rules

The following data must not be emitted in logs:

- API keys and bearer tokens
- full `Authorization` headers
- cookies and session material
- raw third-party provider responses unless explicitly sanitized
- full request bodies that may grow unbounded or contain secrets

Specific rules for this repo:

- Do not log `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, or `CUSTOM_MARKET_API_KEY`.
- Do not log outbound OpenRouter authorization headers.
- Do not log whole evidence payloads or whole verdict traces in routine info logs.
- When logging model or provider calls, include safe metadata such as model name, provider name, status code, attempt count, and duration.

## 12. Log Levels

- `debug`
  - highly detailed local diagnostics; off or minimized in normal runs
- `info`
  - normal lifecycle and business events
- `warn`
  - degraded but recoverable behavior such as retries, fallbacks, or partial unavailability
- `error`
  - request failures, worker failures, unexpected exceptions, and fatal process conditions

Guidance:

- Retries should usually log `warn`, not `error`, unless all retries are exhausted.
- Validation failures caused by client input should generally be `info` or `warn`, not `error`, unless they indicate a bug or abuse pattern.
- Final unhandled failures should log exactly once at the top boundary whenever possible to avoid duplicate stack spam.

## 13. Configuration

Phase 1 should add minimal configuration:

- `LOG_LEVEL`
  - default `info`
- `NODE_ENV` or service-equivalent environment label for TypeScript processes
- `APP_ENV` or equivalent optional normalized environment override for Python if needed

Service names should be code-defined rather than user-provided for stability:

- API service: `api`
- Judge service: `judge`
- Harness script: `harness`

No collector/export configuration is required in phase 1 because the sink is `stdout`/`stderr`.

## 14. Testing Strategy

### 14.1 TypeScript tests

Add focused tests that verify:

- emitted log lines are valid JSON
- required fields are present
- errors serialize into the normalized `error` object
- request-scoped logs preserve the same `requestId`
- worker logs include expected operation metadata

### 14.2 Python tests

Add focused tests that verify:

- log records render as valid JSON lines
- bound request context appears in downstream module logs
- exception logging conforms to the normalized error shape
- OpenRouter retry logs emit stable `event` names and safe context

### 14.3 End-to-end verification

Manual or integration verification should confirm:

1. API ingress generates or propagates `x-request-id`.
2. API-to-judge calls forward the same ID.
3. Judge logs include the forwarded `requestId`.
4. Server-side scripts emit the same contract with their own service name.

## 15. Rollout Plan

### 15.1 Slice 1: Contract and helpers

- Add this design document.
- Implement the TypeScript logging helper and the Python logging bootstrap.
- Add tests for base formatting and error normalization.

### 15.2 Slice 2: API integration

- Enable structured Fastify logging.
- Bind request IDs at ingress.
- Replace ad hoc API error-only logging with boundary logs for request and worker flows.

### 15.3 Slice 3: Judge integration

- Configure process-wide JSON logging.
- Add request middleware for bound request context.
- Normalize OpenRouter warning and failure logs to stable events.

### 15.4 Slice 4: Script integration

- Replace harness `console.log` / `console.error` output with structured logger usage.
- Keep the optional end-of-run human summary if it remains useful.

## 16. Risks And Mitigations

### 16.1 Risk: contract drift between languages

Mitigation:

- Keep one documented contract in `docs/designs`.
- Add tests in each runtime for required field presence and error normalization.
- Prefer fixture-like sample log assertions for key events.

### 16.2 Risk: duplicated or noisy logs

Mitigation:

- Log once at the top boundary for request/job completion and failure.
- Keep lower-level module logs focused on events that add diagnostic value.
- Avoid logging full payloads on happy paths.

### 16.3 Risk: accidental secret leakage

Mitigation:

- Define forbidden fields explicitly.
- Centralize error normalization and context filtering.
- Review integration logs around third-party HTTP clients carefully.

### 16.4 Risk: future collector mismatch

Mitigation:

- Keep the contract flat, explicit, and JSON-native.
- Reserve `traceId` now.
- Use machine-stable `event` names instead of collector-specific fields.

## 17. Success Criteria

Phase 1 is successful when:

- the API, judge service, and harness all emit valid JSON log lines
- every log line includes the canonical base fields
- API and judge logs can be joined by the same `requestId`
- known warning and failure paths use stable `event` names
- sensitive values are not present in emitted logs
- local Docker and direct dev runs remain easy to read and operate

## 18. Open Questions

These questions are intentionally deferred beyond phase 1:

- whether to add `traceparent` or OTEL-compatible propagation later
- whether to standardize numeric `severityNumber` fields for collector compatibility
- whether the browser app should adopt a related but separate client-log contract
- whether to introduce a collector-specific transport once a hosted observability stack is chosen
