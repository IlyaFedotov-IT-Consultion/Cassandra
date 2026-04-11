# Cassandra

Cassandra is a research prototype for multi-source event forecasting. The repository is organized as a hybrid monorepo with TypeScript services for orchestration and UI plus a Python judging service for probabilistic inference, calibration, and evaluation.

## Current Status

The repository currently contains:

- `pnpm` workspace metadata
- shared TypeScript compiler settings
- local Docker Compose infrastructure
- root migration script scaffolding
- environment variable template
- the shared schema package
- the API service skeleton
- planning and design documents

## Planned Layout

```text
apps/
  api/       Fastify orchestration API
  web/       Operator-facing inspection UI
packages/
  shared/    Shared schemas and TypeScript types
services/
  judge/     Python FastAPI judge service
docs/
  designs/   Solution design documents
  plans/     Implementation plans
```

## Prerequisites

- Node.js 22+
- `pnpm` 10+
- Python 3.12+
- Docker with Docker Compose

## Local Setup

1. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

   The default local mode is `CASSANDRA_ADAPTER_MODE=fixture`, which is intended for offline iteration without live third-party API calls. Switch to `live` only when you want real judgments or historical replay against external providers.

2. Install workspace metadata and create the lockfile:

   ```bash
   pnpm install
   ```

3. Start local infrastructure:

   ```bash
   docker compose up -d postgres redis
   ```

4. Stop local infrastructure when finished:

   ```bash
   docker compose down
   ```

## Environment Variables

The root `.env.example` contains the shared configuration used by the API, judge service, and web app. The most important values are:

- `DATABASE_URL`
- `REDIS_URL`
- `JUDGE_BASE_URL`
- `VITE_API_BASE_URL`
- `CASSANDRA_ADAPTER_MODE`
- `PERPLEXITY_API_KEY`
- `OPENROUTER_API_KEY`
- `POLYMARKET_GAMMA_URL`
- `POLYMARKET_CLOB_URL`

## Commands

The root package exposes workspace-wide scripts for future packages:

```bash
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm db:migrate
```

`pnpm db:migrate` is the root entrypoint for applying the API schema once `apps/api/src/db/schema.sql` exists in Task 4.
