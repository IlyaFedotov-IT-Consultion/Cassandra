# Cassandra 1.1

Cassandra is a research prototype for multi-source event forecasting. The repo combines a TypeScript orchestration API, a shared schema package, and a Python judge service that produces probabilistic verdict traces and calibration snapshots.

Judgment execution is queue-backed: the API persists a `queued` judgment, enqueues a BullMQ job in Redis, and a worker calls the Python judge service to produce the terminal trace.

## Repository Layout

```text
apps/
  api/       Fastify orchestration API and persistence layer
packages/
  shared/    Shared Zod schemas and generated JSON schema artifacts
services/
  judge/     FastAPI judge and calibration service
docs/
  designs/   Solution design documents
  plans/     Implementation plans
```

## Current State

Today the repository includes working implementations for:

- the shared schema package in `packages/shared`
- the Fastify API in `apps/api`
- the Python judge service in `services/judge`
- the operator web console in `apps/web`
- Postgres and Redis local infrastructure
- database migrations for operational and evaluation tables
- route and scoring tests across the TypeScript and Python services

Still planned or partial:

- the operator workspace is implemented, but it is still a prototype and not a final production dashboard
- there is no generated OpenAPI or Swagger document yet; the human-written reference lives in [docs/api-reference.md](docs/api-reference.md)

A fuller implementation snapshot lives in [docs/current-status.md](docs/current-status.md).

## Prerequisites

- Node.js 22+
- `pnpm` 10+
- Python 3.12+
- Docker with Docker Compose for Postgres and Redis
- `psql` is optional but useful for running migrations without Docker exec

## Local Setup

1. Copy the example environment file.

   ```bash
   cp .env.example .env
   ```

2. Install workspace dependencies.

   ```bash
   pnpm install
   ```

3. Start the local data services.

   ```bash
   docker compose up -d postgres redis
   ```

4. Apply the database schema.

   ```bash
   pnpm db:migrate
   ```

   This now prefers a reachable local `DATABASE_URL`, then falls back to starting the
   Docker Compose `postgres` service and applying the schema there.

5. Run the judge service.

   ```bash
   cd services/judge
   uv run uvicorn app.main:app --port 8000 --reload
   ```

6. Run the API watcher.

   ```bash
   pnpm --filter @cassandra/api dev
   ```

   The Compose `api` service also runs `pnpm db:migrate` before starting the dev server.

   Judgment creation now depends on both Redis and the Python judge service in all adapter modes.

7. Run the web console.

   ```bash
   pnpm --filter @cassandra/web dev
   ```

   The web app is a Vite React client and reads the API base URL from `VITE_API_BASE_URL`.

For the full Docker-backed stack, you can also run:

```bash
docker compose --profile app up -d postgres redis api judge web
```

The app containers use isolated dependency volumes for `node_modules` and the judge
virtual environment so container-side installs do not overwrite the host workspace.

The default local mode is `CASSANDRA_ADAPTER_MODE=live`. Historical evaluation imports and runs require live upstream queries so the benchmark set and replay metrics reflect real market data rather than placeholders. In `fixture` mode, evidence providers still use canned fixtures, but the API submits the resulting evidence to the Python judge service so fixture and live runs share the same forecasting core.

The API now emits structured JSON logs by default. In local development, set
`LOG_LEVEL=debug` if you want more detail; in tests, the default app logger stays
silent unless a test injects its own logger explicitly.

## Environment Variables

The shared environment template is in `.env.example`. The most important values are:

- `DATABASE_URL`
- `REDIS_URL`
- `LOG_LEVEL`
- `API_PORT`
- `API_HOST`
- `CASSANDRA_CORS_ORIGINS`
- `CASSANDRA_API_KEY` and `VITE_API_KEY`
- `JUDGE_BASE_URL`
- `JUDGE_PORT`
- `JUDGE_REQUEST_TIMEOUT_MS`
- `VITE_API_BASE_URL`
- `CASSANDRA_ADAPTER_MODE`
- `PERPLEXITY_API_KEY`
- `OPENROUTER_API_KEY`
- `ZAI_API_KEY`
- `ZAI_BASE_URL`
- `ZAI_MODEL`
- `ZAI_WEB_SEARCH_URL`
- `POLYMARKET_GAMMA_URL`
- `POLYMARKET_CLOB_URL`
- `CUSTOM_MARKET_API_BASE_URL`
- `CUSTOM_MARKET_API_KEY`

Access to the API:

- the API listens on `API_HOST`, which defaults to the loopback interface (`127.0.0.1`)
- only the browser origins in `CASSANDRA_CORS_ORIGINS` may call it; the default is the local web app. A request from any other origin gets `403`
- set `CASSANDRA_API_KEY` to require the key as `x-api-key` (or a bearer token) on every route except `/health` and `/ready`. Give the web app the same value as `VITE_API_KEY`
- in live mode a request can start paid search and model calls, so set the key before you bind the API to another interface

Notable logging behavior:

- `LOG_LEVEL` controls the default API logger level and accepts `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`
- the API honors `x-request-id` and otherwise generates a request id for each request
- sensitive auth headers and cookies are redacted from log output

## Commands

Workspace-level commands:

```bash
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm db:migrate
```

Useful package-level commands:

```bash
pnpm --filter @cassandra/api dev
pnpm --filter @cassandra/api test
pnpm --filter @cassandra/web dev
pnpm --filter @cassandra/web test
pnpm --filter @cassandra/shared build
pnpm --filter @cassandra/shared test
cd services/judge && uv run pytest
```

Useful harness command:

```bash
pnpm harness:real
```

The live harness submits judgments through `POST /judgments` and polls `GET /judgments/:id` until the queued run reaches a terminal state.

## Documentation

- [Current project status](docs/current-status.md)
- [API reference](docs/api-reference.md)
- [Solution design](docs/designs/2026-04-11-multisource-forecast-judge-solution-design.md)
- [Implementation plan](docs/plans/2026-04-11-multisource-forecast-judge-implementation-plan.md)
