# Architecture, Algorithms, and Subsystem Review

**Date:** 2026-11-07
**Scope:** Solution architecture, forecasting algorithms, evaluation/backtesting, learning loop, reliability, security, subsystem completeness
**Baseline:** `docs/designs/2026-04-11-multisource-forecast-judge-solution-design.md`, `docs/designs/2026-04-12-architectural-improvements-design.md`
**Method:** Source review of `apps/api`, `services/judge`, `packages/shared`, `apps/web`; read-only probe scripts that import the real modules; workspace build and test runs. Review performed inline, without a separate independent reviewer.

---

## 1. Summary

The plumbing is in better shape than the April audits describe: the strict build passes, judgments run through a durable BullMQ queue, HTTP calls have timeouts, and schema contracts are generated and drift-tested. The forecasting core is not doing what the verdict trace claims:

- the market prior is always `0.5` in every live and replay path that reaches the Python judge,
- the evidence selector silently drops whole source families before the judge sees them,
- judges with no evidence get full weight,
- the calibration learners would degrade forecasts once they activate,
- and the evaluation harness cannot answer whether the model adds value, because the model never sees the market price it is compared against.

### What is solid

- Schema-first contracts: Zod → JSON Schema → generated Pydantic, with a drift test.
- Inspectable verdict traces; honest `replayFidelity` labelling during replay.
- Explicit leak assertion for `model_without_polymarket`.
- Durable queue, request timeouts, explicit transactions; strict TypeScript build passes.

---

## 2. P0 — The forecast does not compute what the trace says

### 2.1 Market prior is always 0.5

`services/judge/app/api.py` `_collect_market_signals` reads only `metadata.price` and `metadata.depth`. No provider emits `depth`, so `depth_support = 1 - exp(-0 / 50000) = 0` and the liquidity-adjusted market probability collapses to `0.5`. Gamma items carry `outcomePrices`; the historical benchmark item carries `liquidity`.

Probe output (real modules):

```
CLOB item          {price: 0.85}                   -> market prior 0.500
Benchmark snapshot {price: 0.85, liquidity: 250k}  -> market prior 0.500
Gamma item         {outcomePrices: [...]}          -> market prior 0.500
```

Consequence: `model_with_polymarket` ≈ `model_without_polymarket`; the design's central evaluation question (§15.6) is unanswerable. The TypeScript insufficient-evidence path reads `outcomePrices`/`liquidity` differently, so the two paths compute different priors for the same evidence.

### 2.2 Evidence selection drops whole families

`apps/api/src/modules/judgments/service.ts` caps judge input at 12 items with 4 per family, sorted by family priority (official/government → community → web/llm_research → markets). With a typical live mix, the cap fills before web, research, or market evidence is reached:

```
collected:     official 4, government 4, community 4, web 5, llm_research 5, prediction_market 1
sent to judge: { government: 4, official: 4, community: 4 } (total 12)
```

`open_web_research` receives nothing and the market item never reaches the prior.

### 2.3 Evidence-free judges get full weight

`services/judge/app/scoring/aggregate.py` sets `freshness = 1.0` when a judge has no evidence, but the LLM is still called and its strength still counts. Thirty-day-old official evidence decays to `0.014` (`exp(-age / 168h)` is an e-folding time, not a half-life). Probe: the evidence-free judge contributed `−1.5` log-odds versus `+0.02` from the official-records judge.

### 2.4 Gamma live search returns unrelated markets

- The slug lookup expects `{markets: [...]}` but Gamma returns an array, so it always falls through.
- The fallback fetches the top five global markets by volume and keeps any sharing a word longer than three characters; "will" matches nearly every market.
- The provider stamps the event's entities onto those markets, so they pass the relevance filter.
- `polymarketMarketId` is used as a slug for Gamma and as a condition id for CLOB.

---

## 3. P0 — The learning loop would make forecasts worse

| # | Finding | Location | Evidence |
|---|---|---|---|
| 3.1 | "Isotonic" calibration is a cumulative prefix mean with a running max, not Pool Adjacent Violators | `calibration.py` `_fit_isotonic_outputs` | Perfectly calibrated data: 0.5 → 0.26, 0.9 → 0.41 |
| 3.2 | "Warming" logistic fit fixes slope at 1 and uses a probability-space intercept in logit space | `calibration.py` warming branch | Overconfident 0.9/0.1 forecasts with true rate 0.5 stay 0.9/0.1 |
| 3.3 | Train/serve skew: fit on `finalProbability` (already calibrated), applied to the pre-calibration posterior, which is never persisted | `calibration.py`, `api.py` | Trace stores pre-shrinkage and post-calibration values only |
| 3.4 | Training data can include judgments made after resolution; outcomes not unique; regime counts outcomes not matched pairs | `backtests/repository.ts` `loadCalibrationTrainingData` | `DISTINCT ON ... ORDER BY updated_at DESC` |
| 3.5 | Weights learned from judge `probability` but aggregation uses `evidenceStrength`; a single η=0.2 step from uniform moves weights ~3%; weights sum to 1 so adding a judge shrinks every update | `calibration.py`, `weights.py` | Code inspection |
| 3.6 | Confidence band resamples judges' self-reported probabilities assigned round-robin to evidence items, then stretches to include the final probability | `api.py` `_cluster_groups`, `uncertainty.py` | Probe |
| 3.7 | Dependency discount is structurally inert: judges partition evidence by family, so Jaccard overlap is always 0 | `aggregate.py` | Probe: discounts `[1.0, 1.0, 1.0]` |

The real dependencies are within-family rewrites of one wire story and the overlap between public news and the market price. Treating the market as a prior and news-derived judge updates as independent likelihoods double counts public information.

---

## 4. P1 — Evaluation cannot produce trustworthy evidence yet

1. **Deadline leakage:** replay sets `deadline = market.resolvedAt`, which prefers `closedTime`. For markets resolved YES early, the judge is told the date the event happened. Cutoffs anchored to resolution time make horizons outcome-dependent. Use the market's original end date.
2. **Present-day retrieval:** providers ignore `evaluationTime`; recency filters are relative to now; results are ranked by today's relevance; undated results are stamped "now". The judge prompt contains no as-of date.
3. **Reference class always null in replay:** `base_rate_only` is a constant 0.5 and the prior always falls back.
4. **Statistics:** baselines scored on different prediction subsets; no ECE or calibration curve in run output despite helpers; win rate on absolute error counts ties as losses; no market-clustered confidence intervals; benchmark page offset 100–199 skipped; `\bwho\b` classifies "Who will…" as science/health.
5. **Execution model:** `POST /evaluation/runs` runs the whole replay synchronously inside one HTTP request, sequentially, persisting only at the end, with no per-prediction traces.

---

## 5. P1 — Architecture, reliability, security

- **Split brain persists:** TypeScript keeps its own prior/calibration/aggregation (~800 lines in `judgments/service.ts`, part of it dead) for insufficient-evidence traces, with a panel definition that differs from Python's.
- **Mutable evidence:** `ON CONFLICT (event_id, url) DO UPDATE` overwrites evidence that historical traces cite, violating append-only trace history.
- **Cost and latency:** judge cache key includes millisecond evaluation time (never hits live); Python makes four sequential LLM calls with retries and keeps running after the TypeScript timeout; a new `httpx.Client` per request is never closed; evidence providers run sequentially.
- **Queue edge cases:** judgment row is created before the queue-configured check (orphan `queued` rows on 503); no job dedupe by judgment id; unapproved calibration snapshots are used when none is approved.
- **Scale and trace metadata:** `/runtime` and `/judgments` load every row; trace id is `trace-{snapshotId}`; `modelVersion` and `replayFidelity` are hardcoded in Python.
- **Security:** no authentication; CORS reflects any origin including preflight, so any page the operator visits can trigger paid judgment or evaluation runs on localhost; raw errors are returned to clients; untrusted web/community text is injected into judge prompts without delimiting; the design's community-influence cap is not implemented.

---

## 6. P2 — Incomplete subsystems

- Watchlist discovery never runs: no route, no `cadence` scheduler, no promotion endpoint.
- Research runs are stored in an in-memory `Map`.
- `apps/web/src/App.tsx` is still ~2,500 lines.
- `docs/current-status.md` is stale (claims `pnpm build` fails; links point to a different checkout path).

---

## 7. Recommended order

1. **Data flow into the forecasting core** — typed market signals, per-judge evidence quotas, evidence-free judges neutral, Gamma provider fix; regression test that the prior reflects a priced market.
2. **Replay leakage and statistics** — original end date as deadline, as-of date in prompts, paired baseline comparison, ECE in run output.
3. **Calibration rebuild** — PAV and Platt fitted on a persisted pre-calibration probability, using only pre-resolution judgments.
4. **One forecasting core** — Python builds insufficient-evidence traces; immutable per-judgment evidence snapshots.
5. **Lock down and scale out** — API key, CORS allowlist, queued evaluation runs.
6. **Finish subsystems** — watchlist scheduler and promotion, web decomposition.

---

## 8. Verification at review time

| Check | Result |
|---|---|
| `cd services/judge && uv run pytest` | 38/39 before the shared build (`test_models.py` needs `packages/shared/dist`); 39/39 after |
| `pnpm install --frozen-lockfile && pnpm build` | Passes (shared, api `tsc`, web `tsc` + vite) |
| `pnpm --filter @cassandra/shared test` / `pnpm --filter @cassandra/web test` | 10/10, 22/22 |
| API tests without database dependency (7 files) | 53/53 |
| Probe scripts against real modules | Reproduced §2.1, §2.2, §2.3, §3.1, §3.2, §3.6, §3.7 |

Not run at review time: API tests requiring Postgres and Redis.

---

## 9. Remediation log

Implementation status of the recommendations above. Changes landed 2026-11-07 (uncommitted at time of writing).

| Item | Status | Change |
|---|---|---|
| §2.1 market prior | done | `extract_market_signal` reads Yes probability from `probability`/`yesPrice`/Yes-token `price`/`outcomePrices`+`outcomes`, and `liquidity` or `depth`; ignores `market` quotes; unknown liquidity gets 0.5 trust; discount in log-odds space (design §8.6); missing market no longer dilutes a sampled base rate |
| §2.2 evidence selection | done | Per-judge quotas (4 each, round-robin across families) plus up to 4 prediction-market prior inputs; TS panel families now match Python |
| §2.3 evidence-free judges | done | Neutral by construction, no LLM call, excluded from disagreement; true half-life per family (official/government 90d, web 14d, community 3d) with 0.1 floor |
| §2.4 Gamma/CLOB providers | done | Lookup by `id`/`slug`/`condition_ids` (incl. closed), `public-search` with relevance scoring instead of global top-N; CLOB only for condition ids, Yes-token midpoint |
| §3.1–3.2 calibration fits | done | Pool Adjacent Violators isotonic; Platt scaling by penalised Newton |
| §3.3 train/serve skew | done | `VerdictTrace.preCalibrationProbability` added and used for fitting; calibrated traces without it are skipped |
| §3.4 training leakage | done | SQL and Python both keep the latest pre-resolution trace per event; one outcome per event; regime counts matched pairs |
| §3.5 weight learning | pending | Still learns from judge `probability` with a single Hedge step |
| §3.6 uncertainty band | done | Bootstrap over informative judges through the real pooling; fixed ±1 log-odds band labelled `none` when fewer than two judges have evidence |
| §3.7 dependency structure | pending | Within-family duplication and news/market double counting not yet modelled |
| §4.1 deadline leakage | done | Benchmark `endDate` imported and stored; replay deadline uses it |
| §4.2 present-day retrieval | partial | As-of date and untrusted-evidence instruction added to judge prompts; retrieval itself is still present-day search |
| §4.3 reference class in replay | pending | |
| §4.4 statistics | partial | Paired baseline summaries and ECE added; page offset 100 and "Who will" theme bug fixed; market-clustered confidence intervals pending |
| §4.5 synchronous evaluation | pending | |
| §5 split brain | done | Insufficient-evidence traces come from the judge service (`priorOnly`); ~700 lines of TS prior/calibration/aggregation removed |
| §5 other reliability/security | pending | Mutable evidence, auth/CORS, queue edge cases, judge cache key, scaling |
| §6 subsystems | pending | |

| Live search backend | done | OpenRouter `web` plugin backend selectable via `CASSANDRA_SEARCH_BACKEND`; Z.AI kept as an option |
| Multi-stage pipeline | done | Query planning, relevance rating/summarization, ensemble consistency guard and per-stage trace records (`pipelineStages`) |
| Outdated models | done | Defaults moved to the current OpenRouter catalog; judge ensemble with per-model reasoning effort (see `docs/research/2026-11-07-llm-forecasting-methods.md`) |

### Defects found during live testing (2026-11-07)

| Defect | Status | Change |
|---|---|---|
| Evidence cache keyed only by question: events sharing a question but bound to different markets or entities reused each other's provider output | fixed | Cache key now includes a hash of `polymarketMarketId`, entities and market symbols |
| Benchmark snapshots carry end-of-life liquidity (0 once resolved), which the prior read as zero depth and which leaks post-cutoff information | fixed | Replay exposes it as `finalLiquidity`/`finalVolume`; the prior treats cutoff liquidity as unknown |
| Benchmark import samples only the most recent closures (one hour of mostly sports markets) and the keyword theme classifier labels them `general` | open | Needs a time-stratified sample and a better sports/other filter |
| `ZAI_API_KEY` in `.env` is rejected by Z.AI (HTTP 401), including the Coding Plan endpoint used by opencode | environment | Search switched to OpenRouter. GLM-5.3 ran briefly through OpenRouter, then was replaced in the ensemble by `deepseek/deepseek-v4.1-flash-1017` |

### Verification after remediation

| Check | Result |
|---|---|
| `cd services/judge && uv run pytest` | 64 passed |
| `cd apps/api && npx vitest run` (Postgres 17 + Redis 7.4 containers) | 147 passed, 24 files |
| `pnpm --filter @cassandra/shared test` / `pnpm --filter @cassandra/web test` | 10 / 22 passed |
| `pnpm build` | passes; generated Pydantic models match the shared schema |
| `pnpm harness:real` (live OpenRouter, Z.AI, Polymarket) | 3/5 scenarios pass; both failures are Z.AI 401 |
| `pnpm harness:real` with OpenRouter search and the four-model ensemble | 5/5 scenarios pass |
| Live judgment bound to a real Polymarket market (0.979 Yes, $315k liquidity) | prior 0.9787 (was 0.5); prior-only path, no LLM calls |
| Live panel judgment (sonar-retrieved Federal Reserve sources + live market, GPT-5) | one LLM call; neutral judges skipped; rationale reasons "as of" the evaluation date; posterior 0.987 from prior 0.979 |
| Live replay evaluation, 3 markets | `model_with_polymarket` follows historical prices (0.24 → 0.36) instead of 0.5; paired Brier 0.156 vs market 0.094 vs uninformed 0.250 |
