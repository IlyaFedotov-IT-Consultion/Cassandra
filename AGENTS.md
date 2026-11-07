# Cassandra

Research prototype for multi-source event forecasting. A Fastify API collects evidence and queues judgments, a Python judge service turns evidence into calibrated probabilities, and a React workspace shows traces, evaluation runs and calibration. Human setup lives in `README.md`; HTTP contracts live in `docs/api-reference.md`.

## Layout

- `apps/api`: Fastify 5 API with BullMQ queues and Postgres.
  - Each domain lives in `src/modules/<domain>/`, with SQL in `repository.ts`, HTTP in `routes.ts`, and orchestration in `service.ts` where needed.
  - SQL schema: `src/db/schema.sql` and `src/db/evaluation_schema.sql`.
  - Tests: `test/*.test.ts`.
- `apps/web`: React 19, Vite, TanStack Query and react-router.
  - Routes are in `src/App.tsx`, screens in `src/pages/` and shared UI in `src/components/`.
  - Every API call goes through `src/api.ts`.
  - Tests: `test/`.
- `services/judge`: FastAPI judge service (Python 3.12, uv). Tests: `tests/`.
- `packages/shared`: Zod schemas in `src/schemas.ts`, shared by the API and web. Its build exports `dist/schemas.json` for the judge. Tests sit next to the source as `src/*.test.ts`.
- `scripts/harness`: live end-to-end harness.
- `docs/{designs,plans,research,reviews}`: dated notes named `YYYY-MM-DD-topic.md`.

## Commands

Run these from the repo root unless a line says otherwise.

- Install: `pnpm install`. Judge dependencies: `cd services/judge && uv sync`.
- Infrastructure: `docker compose up -d postgres redis`.
- Migrate: `pnpm db:migrate` (database `cassandra`) and `pnpm db:migrate-test` (database `cassandra_test`).
- Dev: `pnpm dev` starts the API and web.
  - The judge runs separately: `cd services/judge && uv run uvicorn app.main:app --port 8000 --reload`.
- Tests:
  - All TypeScript: `pnpm test`.
  - One package: `pnpm --filter @cassandra/<api|web|shared> test`.
  - One file: `pnpm --filter @cassandra/web exec vitest run test/api.test.ts`.
  - Judge: `cd services/judge && uv run pytest`.
  - Harness unit tests, which are in no package suite: `pnpm exec vitest run scripts/harness/real-e2e-support.test.ts`.
- Type-check and build everything: `pnpm build`.
- `pnpm lint` does nothing: no linter or formatter is configured.

## Gotchas

- **API tests:**
  - They need Postgres on 5432 and Redis on 6379.
  - Vitest points them at `cassandra_test`, and they `TRUNCATE` every table before each test. Never point their `DATABASE_URL` at a database whose data matters.
  - The `pretest` step rebuilds `packages/shared` and migrates both databases, so it needs `psql` or Docker.
- **Schema changes:** there is no migration framework. Both SQL files are re-applied on every migrate, so every change must be idempotent (`CREATE ... IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
- **Strict schemas:** most shared schemas are `.strict()`, so a response with an extra field fails parsing in `apps/web/src/api.ts`. Change the schema in `packages/shared` first, then the producer and the consumer.
- **After editing `packages/shared/src/schemas.ts`:**
  1. Run `pnpm --filter @cassandra/shared build`.
  2. Run `services/judge/scripts/generate-models.sh` to regenerate `services/judge/app/models_generated.py`.
  3. Never hand-edit generated files or anything in `dist/`.
- **Web tests:** they render `<App />` in a `MemoryRouter` with `fetch` stubbed. Copy the helpers in `apps/web/test/workspace-ux.test.tsx`.
- **UI changes:** there is no Playwright install in the repo. Check them in a real browser against `pnpm dev` at desktop and phone widths, for example through the Playwright MCP. Keep screenshots in `.playwright-mcp/`, which is gitignored.

## Live mode and secrets

- Copy `.env.example` to `.env`. Never commit `.env` or print key values.
- `.env.example` defaults to `CASSANDRA_ADAPTER_MODE=live`. For offline work, set `CASSANDRA_ADAPTER_MODE=fixture` and keep `CASSANDRA_JUDGE_LLM=fake`, which gives a deterministic judge.
- Live mode and `pnpm harness:real` call OpenRouter, Perplexity and Polymarket and cost money. Run them only when asked.
- In live mode the API's scheduled watchlist discovery (on by default) also costs money. Set `CASSANDRA_DISCOVERY_SCHEDULE=off` when running a live API you do not want spending on its own.
- Model IDs and reasoning effort belong in the `OPENROUTER_*` env vars, never in code. The current choices are explained in `docs/research/2026-11-07-llm-forecasting-methods.md`.

## Style and tests

- TypeScript is strict ESM: 2-space indentation, double quotes, semicolons, small focused modules. Name exported schemas explicitly, for example `EventInputSchema`.
- Add or update tests with every behavior change. Test API routes through `app.inject` and pages through Testing Library roles and labels.

## Commits and pull requests

- Use Conventional Commits with a scope, such as `feat(api):`, `fix(judgments):`, `test(harness):` or `docs:`. Keep one logical change per commit.
- A PR description covers:
  - a summary;
  - the affected packages;
  - the test commands run and their results;
  - any migration or env changes;
  - screenshots for UI changes.
