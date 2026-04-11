# Cassandra

Cassandra is a research prototype for multi-source event forecasting. The repository is organized as a hybrid monorepo with TypeScript services for orchestration and UI plus a Python judging service for probabilistic inference, calibration, and evaluation.

## Current Status

The repository currently contains the Task 1 root scaffold:

- `pnpm` workspace metadata
- shared TypeScript compiler settings
- local Docker Compose infrastructure
- environment variable template
- planning and design documents

The application packages themselves have not been scaffolded yet.

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
```

These are currently no-ops until the individual packages are created.
