# Repository Guidelines

## Project Structure & Module Organization
This repository is a `pnpm` monorepo for the Cassandra forecasting prototype. Current code lives in `apps/api` (Fastify API) and `packages/shared` (shared Zod schemas and generated schema artifacts). Keep API runtime code under `apps/api/src`, API tests under `apps/api/test`, and shared package tests alongside source as `packages/shared/src/*.test.ts`. Design notes and implementation plans belong in `docs/designs` and `docs/plans`. Build output is generated into each package’s `dist/` directory and should not be edited manually.

## Build, Test, and Development Commands
- `pnpm install` installs workspace dependencies.
- `docker compose up -d postgres redis` starts local infrastructure required by the API repository tests.
- `pnpm dev` runs all workspace `dev` scripts; today this starts the API watcher.
- `pnpm build` compiles all packages and regenerates shared JSON schema output.
- `pnpm test` runs all workspace tests.
- `pnpm --filter @cassandra/api test` runs API tests only.
- `pnpm db:migrate` applies `apps/api/src/db/schema.sql` using local `psql` or the Docker Postgres container.

## Coding Style & Naming Conventions
Use TypeScript with ESM modules, strict compiler settings, and 2-space indentation. Follow the existing style: double quotes, semicolons, and small focused modules. Export shared validators and types with explicit names such as `EventInputSchema`; keep repository implementations in `apps/api/src/modules/<domain>/repository.ts`. Use lowercase directory names and `*.test.ts` for test files. No dedicated formatter or linter is configured yet, so match surrounding code closely and keep imports orderly.

## Testing Guidelines
Vitest is the active test runner across the workspace. API tests use the Node environment and are discovered from `apps/api/test/**/*.test.ts`; shared package tests are colocated in `src`. Add or update tests with every behavior change, especially for schema validation, repository persistence, and health/readiness endpoints. Run `pnpm test` before opening a PR; ensure Docker-backed Postgres and Redis are available when exercising integration-style API tests.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commits (`feat:`, `docs:`, `chore:`); keep using that format with concise subjects. PRs should include a short summary, affected packages, test evidence (`pnpm test`, targeted package commands), and any migration or environment changes. Include screenshots only when future UI work touches a visual surface.

## Configuration & Security Tips
Seed local configuration from `.env.example` and do not commit secrets in `.env`. Prefer `CASSANDRA_ADAPTER_MODE=fixture` for offline development; switch to `live` only when the required external API keys are configured intentionally.
