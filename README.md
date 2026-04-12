# Cassandra

Cassandra is a research prototype for multi-source event forecasting. The repo combines a TypeScript orchestration API, a shared schema package, and a Python judge service that produces probabilistic verdict traces and calibration snapshots.

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

5. Run the API watcher.

   ```bash
   pnpm --filter @cassandra/api dev
   ```

   The Compose `api` service also runs `pnpm db:migrate` before starting the dev server.

6. Run the judge service.

   ```bash
   cd services/judge
   uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
   ```

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

The default local mode is `CASSANDRA_ADAPTER_MODE=fixture`, which is intended for offline iteration without live third-party API calls. Switch to `live` only when the required upstream credentials are intentionally configured.

The API now emits structured JSON logs by default. In local development, set
`LOG_LEVEL=debug` if you want more detail; in tests, the default app logger stays
silent unless a test injects its own logger explicitly.

## Environment Variables

The shared environment template is in `.env.example`. The most important values are:

- `DATABASE_URL`
- `REDIS_URL`
- `LOG_LEVEL`
- `API_PORT`
- `JUDGE_BASE_URL`
- `JUDGE_PORT`
- `VITE_API_BASE_URL`
- `CASSANDRA_ADAPTER_MODE`
- `PERPLEXITY_API_KEY`
- `OPENROUTER_API_KEY`
- `POLYMARKET_GAMMA_URL`
- `POLYMARKET_CLOB_URL`
- `CUSTOM_MARKET_API_BASE_URL`
- `CUSTOM_MARKET_API_KEY`

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

## Documentation

- [Current project status](docs/current-status.md)
- [API reference](docs/api-reference.md)
- [Solution design](docs/designs/2026-04-11-multisource-forecast-judge-solution-design.md)
- [Implementation plan](docs/plans/2026-04-11-multisource-forecast-judge-implementation-plan.md)
