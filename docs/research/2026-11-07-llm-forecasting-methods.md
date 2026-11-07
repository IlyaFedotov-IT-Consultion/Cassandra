# LLM Forecasting Methods: Research Notes

**Date:** 2026-11-07
**Question:** Which current methods for LLM-based event forecasting, forecast aggregation, calibration, market combination and leakage-safe evaluation should Cassandra adopt, and which models should it run?
**Method:** Primary sources only — arXiv full text and abstracts (fetched via the arXiv API and arXiv HTML), publisher/proceedings pages, Crossref metadata, OpenRouter's live model catalog (`GET /api/v1/models`) and OpenRouter documentation, plus live API calls made from this repository. Research done inline; no separate reviewer.

---

## 1. Findings

### 1.1 Multi-stage retrieval → reasoning → aggregation is the best-documented architecture

Halawi, Zhang, Yueh-Han & Steinhardt, *Approaching Human-Level Forecasting with Language Models* (arXiv:2402.18563, 2024) [S1]:

- The system decomposes forecasting into **retrieval, reasoning and aggregation**, each driven by an LM.
- Retrieval has **four steps: search-query generation, news retrieval, relevance filtering and re-ranking, and text summarization**.
- A plain query-expansion prompt "overlooks sub-considerations", so they **decompose the question into sub-questions and generate one search query per sub-question**, combined with direct expansion.
- Relevance is rated on a **6-point scale**, with articles above a **threshold of 4** counted as relevant.
- Reasoning prompts the model with **scratchpad prompts** (the best three found by sweep) plus a fine-tuned model sampled three times at T=0.5, giving **six forecasts**.
- Five ensembling methods were compared (mean, median, geometric mean, trimmed mean, a universal self-consistency variant); a **trimmed mean** won on validation. Their variant halves the weight of the forecast furthest from the median.
- Results on a post-cutoff test set: system Brier **.179** vs crowd **.149**.
- **Weighted average of system and crowd (4× crowd weight) reaches .146**, beating both.
- The system "nears the performance of the crowd when there are at least 5 relevant articles".
- Weakness: it "rarely outputs low probabilities", attributed to **hedging**, and its relative score improves more slowly as questions approach resolution.
- Calibration: the system was "naturally well calibrated", and "standard calibration methods such as binning or isotonic regression do not improve performance".

Yan et al., *AutoCast++* (arXiv:2310.01880, 2023) [S2]:

- Pipeline: zero-shot question–passage **relevance re-ranking**, then zero-shot **summarization** of the chosen articles.
- Re-ranking **prefers more recent articles**, because recent news can contradict earlier reports.

### 1.2 Ensembles across models and samples

Schoenegger, Tuminauskaite, Park & Tetlock, *Wisdom of the Silicon Crowd* (arXiv:2402.19379) [S3]:

- An ensemble of **twelve LLMs** was not statistically different from a 925-person human crowd on 31 binary questions.
- It showed an **acquiescence effect** (mean predictions significantly above 50% despite balanced outcomes).
- Showing models the human median improved accuracy by 17–28%, but **simply averaging human and machine forecasts was better still**.

Schoenegger & Park (arXiv:2310.13014) [S4]: a single GPT-4 in a live Metaculus tournament was **not significantly different from always answering 50%**.

Turtel et al., *Outcome-based Reinforcement Learning to Predict the Future* (arXiv:2505.17989) [S5]:

- RL with verifiable rewards on prediction-market questions plus news headlines let a 14B model match or surpass o1 with better calibration.
- Inference uses **median prediction sampling**.

### 1.3 Aggregation theory: averaging compresses toward 0.5

- **Baron, Mellers, Tetlock & Stone, *Two Reasons to Make Aggregated Probability Forecasts More Extreme*** (Decision Analysis, 2014, doi:10.1287/deca.2014.0293) [S6]: weighted averages of probabilities correspond better to reality when pushed toward 0 or 1. One stated cause is that the probability scale is compressed at the ends, so **random error pushes the average toward 0.5**.
- **Satopää et al., *Combining multiple probability predictions using a simple logit model*** (IJF 30(2), 2014, doi:10.1016/j.ijforecast.2013.09.009) [S7]: a likelihood-based **log-odds aggregator with a single interpretable parameter**. It is "robust against overfitting" and beat widely used aggregators on 1,300+ experts × 69 geopolitical events.
- **Mellers et al., *Psychological Strategies for Winning a Geopolitical Forecasting Tournament*** (Psych. Science, 2014, doi:10.1177/0956797614524255) [S8]: training (including **reference classes** and **averaging multiple estimates**), teaming and tracking drove accuracy.

### 1.4 Calibration on small samples

- **Niculescu-Mizil & Caruana, *Predicting Good Probabilities With Supervised Learning*** (ICML 2005) [S9]: Platt scaling fits sigmoid-shaped distortions. Isotonic regression corrects any monotonic distortion but "is more prone to overfitting, and thus performs worse than Platt Scaling, when data is scarce".
- **Kull, Silva Filho & Flach, *Beta calibration*** (AISTATS 2017, PMLR 54) [S10]: isotonic "is however prone to overfitting on smaller datasets". Logistic calibration on raw scores cannot express the identity map and "can easily uncalibrate a perfectly calibrated classifier". Beta calibration `sigmoid(a·ln p − b·ln(1−p) + c)` fixes this and is as easy to fit.

### 1.5 Leakage-safe evaluation

- **Zou et al., *Autocast*** (arXiv:2206.15474) [S11]: a news corpus **organized by date** lets past forecasts be simulated without future leakage. Accuracy improved with model size and relevant retrieved news.
- **Karger et al., *ForecastBench*** (arXiv:2409.19839) [S12]: to "avoid any possibility of data leakage", it uses **only questions about future events with no known answer at submission**. Expert forecasters beat the top LLM (p < 0.001).
- **Paleka, Goel, Geiping & Tramèr, *Pitfalls in Evaluating Language Model Forecasters*** (arXiv:2506.00723, 2025) [S13]:
  - **Logical leakage in backtesting:** questions selected because they have since resolved constrain the answer.
  - **Unreliable date-restricted retrieval:** document dates are often wrong, and retrievers trained on future data leak through learned associations.
  - **Knowledge cutoffs are unreliable:** "a guideline … not a guarantee".
  - **Piggybacking** on human or market forecasts.
  - Report **at least Brier score, calibration and log score**, and ideally use **live evaluations on prediction markets**.
- **Paleka et al., *Consistency Checks for Language Model Forecasters*** (arXiv:2412.18544) [S14]: an arbitrage-based **consistency metric over logically related questions** (for example a question and its negation). It correlates with eventual Brier score, so it is usable *before* questions resolve.
- **Diebold & Mariano, *Comparing Predictive Accuracy*** (JBES 1995, doi:10.1080/07350015.1995.10524599) [S15]: the standard test for equal predictive accuracy of two forecasters. Metadata verified via Crossref; abstract not deposited.

### 1.6 Current models and API capabilities (OpenRouter, 2026-11-07)

From `GET https://openrouter.ai/api/v1/models` (460 models) [S16]:

| Model | Added | $/M in | $/M out | Notes from catalog |
|---|---|---|---|---|
| `openai/gpt-6.1-sol` (+`-pro`) | 2026-09 | 2.00 (pro) | 10.00 (pro) | OpenAI top tier |
| `openai/gpt-6.1-terra` | 2026-10-26 | 1.00 | 5.00 | "mid-tier model in OpenAI's GPT-6.1 series" |
| `anthropic/claude-opus-5.5` | 2026-09-22 | 4.00 | 20.00 | Anthropic flagship for demanding reasoning |
| `anthropic/claude-sonnet-5.5` | 2026-09-28 | 2.00 | 10.00 | |
| `anthropic/claude-haiku-5.5` | 2026-10-07 | 0.10 | 0.50 | small/fast |
| `google/gemini-4-argon` | 2026-10-13 | 2.00 | 10.00 | Google flagship reasoning |
| `x-ai/grok-4.7` | 2026-09-21 | 2.00 | 6.00 | |
| `z-ai/glm-5.3` | 2026-08-18 | 0.07 | 1.40 | Z.ai flagship reasoning, 1M context |
| `deepseek/deepseek-v4.1-flash-1017` | 2026-10-17 | 0.15 | 0.60 | October 17 snapshot of DeepSeek V4.1 Flash |

The configured defaults were `openai/gpt-5` (judge and cross-examiner) and `perplexity/sonar` (search): 2025-era models.

OpenRouter `reasoning.effort` accepts `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. `max`/`xhigh` allocate about 95% of `max_tokens` to reasoning, so `max_tokens` must leave room for the answer [S17].

The `web` plugin supports `engine` (`native`, `exa`, `firecrawl`, `parallel`, `perplexity`), `max_results` (1–25) and `include_domains`/`exclude_domains` with wildcards [S18].

**Live judge-shaped call** (strict JSON schema; same Fed-meeting question and one evidence item; run from this repo 2026-11-07):

| Model | Effort | Output | Reasoning tokens | Cost | Latency |
|---|---|---|---|---|---|
| openai/gpt-6.1-sol | high | p=0.40, weak_against | 314 | $0.0048 | 10.4s |
| openai/gpt-6.1-terra | high | p=0.30, weak_against | 589 | $0.0035 | 8.6s |
| anthropic/claude-opus-5.5 | high | p=0.35, weak_for | 214 | $0.0103 | 7.3s |
| google/gemini-4-argon | high | p=0.38, weak_against | 1145 | $0.0138 | 25.2s |
| z-ai/glm-5.3 | max | p=0.60, moderate_for | 5102 | $0.0086 | 55.5s |
| x-ai/grok-4.7 | high | p=0.34, weak_against | 1413 | $0.0104 | 34.4s |
| deepseek/deepseek-v4.1-flash | high | p=0.50 / 0.60, neutral (2 runs) | 6355 / 7765 | $0.0078 / $0.0033 | 44.0s / 49.1s |
| deepseek/deepseek-v4.1-flash-1017 | high | p=0.40 moderate_against / p=0.60 weak_against (2 runs) | 1723 / 2498 | $0.0006 / $0.0013 | 9.0s / 13.8s |

All six returned schema-valid JSON. Single samples disagree (0.30–0.60), and one pairs `weak_for` with p=0.35. This is the variance and label ambiguity that §1.2 ensembling addresses.

---

## 2. Gap analysis against Cassandra

Live observations (2026-11-07 harness run, GLP-1 approval question, OpenRouter search):

- **Judges disagree by evidence slice:** `official_records` p=0.12 vs `open_web_research` p=0.90 on the same question.
- **Run-to-run variance is high:** `open_web_research` gave 0.90 in one run and 0.45 in the next.
- **Final probabilities sit near 0.5 (0.52, 0.48):** the multiplicative discounts (1/3 weights, 0.5 freshness for undated items, shrinkage) compound.

| Finding | Cassandra today | Gap |
|---|---|---|
| Query generation with sub-question decomposition [S1] | One templated query per provider (`question + entities + suffix`) | No LLM query planning |
| LLM relevance rating + re-ranking + summarization [S1, S2] | Keyword/entity overlap filter; raw snippets | No semantic relevance stage; judges see unfiltered snippets |
| ≥5 relevant articles needed [S1] | Coverage gate counts unique URLs (≥2) | Gate measures quantity, not relevance |
| Multiple samples / models, robust aggregation [S1, S3, S5] | One sample per judge, one model | High variance; no ensemble |
| Market/crowd combination [S1, S3] | Market enters as a liquidity-discounted prior | Consistent with the evidence; blend weight is untuned |
| Averaging compresses toward 0.5 → extremize [S6, S7] | Platt fit learns a slope (slope > 1 extremizes) once ≥20 outcomes exist | Supported by the new calibration stage; needs outcome data |
| Isotonic overfits small samples [S9, S10] | Isotonic only at ≥100 outcomes; Platt below | Consistent. Beta calibration is a cheap upgrade if distortion is asymmetric |
| Calibration may not help a calibrated system [S1] | Calibration always applied when fitted | Keep calibration gated on held-out improvement |
| Leakage-safe evaluation [S11–S13] | Replay over resolved markets with present-day search, labelled `approximate` | Logical leakage and retrieval leakage remain; no live/prospective benchmark |
| Consistency checks [S14] | None | Cheap pre-resolution quality signal is missing |
| Current models [S16] | `openai/gpt-5`, `perplexity/sonar` | Outdated defaults; single model family |

---

## 3. Proposed multi-stage pipeline

Each stage has one owner, a typed contract and a trace record, so the trace keeps explaining the result.

| # | Stage | Owner | Method (source) | Cost per judgment |
|---|---|---|---|---|
| 1 | Question decomposition and query planning | judge service | Sub-questions → one query each, plus direct expansion [S1] | 1 small-model call |
| 2 | Retrieval | API | Existing providers, run over planned queries; OpenRouter `web` plugin with domain filters [S18] | ~$0.005 per query |
| 3 | Relevance rating, re-ranking, summarization | judge service | 1–6 relevance, keep ≥4, recency tie-break, short summaries [S1, S2] | 1 batched small-model call |
| 4 | Multi-model, multi-sample reasoning | judge service | Each judge samples K forecasts across diverse model families; aggregate by median/trimmed mean in log-odds [S1, S3, S5] | K × judges calls |
| 5 | Cross-examination | judge service | Existing qualitative conflict review | 1 call |
| 6 | Bayesian pooling with market prior | judge service | Existing log-odds pool, liquidity-adjusted market prior [S1, S3] | none |
| 7 | Consistency check | judge service | Forecast the negated question; report incoherence [S14] | optional, 1–2 calls |
| 8 | Calibration / extremization | judge service | Platt on log-odds now; beta calibration as an upgrade; accept only if held-out Brier improves [S6, S7, S9, S10, S1] | none |
| 9 | Evaluation | API | Paired Brier, log score, ECE; market-clustered CIs; prospective live evaluation on open markets [S12, S13, S15] | — |

---

## 4. Recommended new methods, in priority order

1. **Multi-model, multi-sample judge ensembles (stage 4).** Strongest evidence, directly targets the observed variance [S1, S3, S5]. Aggregate in log-odds with a median or Halawi-style trimmed mean; record per-sample outputs in the trace.
2. **Semantic relevance rating and summarization (stage 3).** Halawi tie performance to having ≥5 *relevant* articles [S1]; AutoCast++ shows re-ranking plus summarization gains [S2]. Replace the keyword gate with relevance-scored coverage.
3. **Query planning with sub-question decomposition (stage 1).** Broadens retrieval coverage [S1].
4. **Prospective evaluation on open Polymarket markets.** Freeze forecasts now and score at resolution: the only evaluation free of the leakage modes in [S13], following ForecastBench's design [S12].
5. **Consistency checks (stage 7)** as an instantaneous quality metric [S14].
6. **Beta calibration** as the parametric option once enough outcomes exist [S10], gated on held-out improvement.

Not recommended now: fine-tuning or RL on outcomes [S1, S5]. It needs thousands of resolved questions and an outcome pipeline Cassandra does not have yet.

---

## 5. Model recommendations

- **Reasoning panel (stage 4): one model per family** for decorrelated errors [S3]: `openai/gpt-6.1-sol`, `anthropic/claude-opus-5.5`, `google/gemini-4-argon`, plus `deepseek/deepseek-v4.1-flash-1017` at `reasoning.effort=high` as a low-cost fourth voice. All verified live above.
- `z-ai/glm-5.3@max` was the original fourth voice. It was replaced after live runs: it contradicted its own probability in 3 of 6 samples and took about 55s per call. The DeepSeek snapshot is faster, cheaper and coherent in its test calls.
- **Cross-examiner:** a family different from the primary reasoning model, e.g. `anthropic/claude-opus-5.5`.
- **Cheap stages (query planning, relevance, summaries, search plugin carrier):** `anthropic/claude-haiku-5.5` or `deepseek/deepseek-v4.1-flash`.
- **Backtesting caveat:** newer models have later training data, so replays over recently resolved markets are more exposed to cutoff leakage [S13]. Record model ids in every trace and prefer prospective evaluation for model comparisons.

---

## 6. Implementation status (2026-11-07)

| Item | Status |
|---|---|
| Stage 2 retrieval via OpenRouter `web` plugin (Perplexity engine, domain filters, URL/content date inference) | done (`CASSANDRA_SEARCH_BACKEND=openrouter`) |
| Stage 4 multi-model ensemble (median in log-odds and over log Bayes factors; per-model samples in `weightBreakdown[].details.samples`; judges run concurrently) | done (`OPENROUTER_JUDGE_MODELS`) |
| Current models and per-model `reasoning.effort` (`model@effort`) | done; defaults GPT-6.1 Sol, Claude Opus 5.5, Gemini 4 Argon, DeepSeek V4.1 Flash 1017@high (replaced GLM-5.3@max); cross-examiner Claude Opus 5.5 |
| `modelVersion` reports the models that actually ran | done |
| Stage 1 query planning (sub-questions → queries, utility model; up to 2 planned queries per search provider) | done (`POST /plan`) |
| Stage 3 relevance rating and summarization (1–6 scale, keep ≥4, gate when rating leaves <2 relevant items) | done |
| Ensemble consistency guard (drop samples whose label contradicts their probability) | done |
| Per-stage records in every trace (`pipelineStages`) | done |
| Stage 7 consistency checks; beta calibration; prospective evaluation | not started |

**Live result** (same GLP-1 question as §2, two independent runs):

| | Single model (gpt-5) | Four-model ensemble |
|---|---|---|
| Final probability, run 1 / run 2 | 0.52 / 0.48 | 0.71 / 0.72 |
| `open_web_research` judge, run 1 / run 2 | 0.90 / 0.45 | 0.95 / 0.94 |

- GLM-5.3 at `max` returned a strength label contradicting its own probability in 3 of 6 samples (`strong_against` with p = 0.85–0.92). The median absorbed it, but a per-sample consistency guard or down-weighting is warranted.
- Judgment latency with the ensemble was about 2.5–4 minutes, bounded by the slowest member.

**Live result with stages 1 and 3 enabled** (same question, two runs): planning produced targeted queries (e.g. "orforglipron FDA approval decision date 2026"). Retrieval returned 29–33 items. The relevance stage rated 14 candidates and kept 5; nine scored 1–3, and all community items were filtered out. Final probabilities were 0.70 and 0.68. Judgment-flow time fell from about 236s to 40s, because judges left without relevant evidence make no LLM calls and prompts are shorter.

---

## 7. Limits of this research

- Results in [S1, S3, S12] were measured on human-tournament questions with 2023–2024 models; effect sizes on Polymarket questions with 2026 models are unmeasured.
- Halawi's finding that calibration did not help applies to *their* system; Cassandra's pooling may be miscalibrated differently (live outputs cluster near 0.5).
- Only [S1] and [S13] were read in full; other sources were read at abstract/introduction level.

---

## Sources

- [S1] Halawi, Zhang, Yueh-Han, Steinhardt. *Approaching Human-Level Forecasting with Language Models.* arXiv:2402.18563 (2024). https://arxiv.org/abs/2402.18563 (full text: https://arxiv.org/html/2402.18563v1)
- [S2] Yan et al. *AutoCast++: Enhancing World Event Prediction with Zero-shot Ranking-based Context Retrieval.* arXiv:2310.01880 (2023). https://arxiv.org/abs/2310.01880
- [S3] Schoenegger, Tuminauskaite, Park, Tetlock. *Wisdom of the Silicon Crowd.* arXiv:2402.19379 (2024). https://arxiv.org/abs/2402.19379
- [S4] Schoenegger, Park. *Large Language Model Prediction Capabilities: Evidence from a Real-World Forecasting Tournament.* arXiv:2310.13014 (2023). https://arxiv.org/abs/2310.13014
- [S5] Turtel et al. *Outcome-based Reinforcement Learning to Predict the Future.* arXiv:2505.17989 (2025). https://arxiv.org/abs/2505.17989
- [S6] Baron, Mellers, Tetlock, Stone. *Two Reasons to Make Aggregated Probability Forecasts More Extreme.* Decision Analysis (2014). https://doi.org/10.1287/deca.2014.0293
- [S7] Satopää, Baron, Foster, Mellers, Tetlock, Ungar. *Combining multiple probability predictions using a simple logit model.* International Journal of Forecasting 30(2):344–356 (2014). https://doi.org/10.1016/j.ijforecast.2013.09.009 (abstract via https://ideas.repec.org/a/eee/intfor/v30y2014i2p344-356.html)
- [S8] Mellers, Ungar, Baron, Ramos et al. *Psychological Strategies for Winning a Geopolitical Forecasting Tournament.* Psychological Science (2014). https://doi.org/10.1177/0956797614524255
- [S9] Niculescu-Mizil, Caruana. *Predicting Good Probabilities With Supervised Learning.* ICML 2005. https://www.cs.cornell.edu/~alexn/papers/calibration.icml05.crc.rev3.pdf
- [S10] Kull, Silva Filho, Flach. *Beta calibration.* AISTATS 2017, PMLR 54:623–631. https://proceedings.mlr.press/v54/kull17a.html
- [S11] Zou et al. *Forecasting Future World Events with Neural Networks.* arXiv:2206.15474 (2022). https://arxiv.org/abs/2206.15474
- [S12] Karger et al. *ForecastBench: A Dynamic Benchmark of AI Forecasting Capabilities.* arXiv:2409.19839. https://arxiv.org/abs/2409.19839
- [S13] Paleka, Goel, Geiping, Tramèr. *Pitfalls in Evaluating Language Model Forecasters.* arXiv:2506.00723 (2025). https://arxiv.org/html/2506.00723v1
- [S14] Paleka et al. *Consistency Checks for Language Model Forecasters.* arXiv:2412.18544 (2024). https://arxiv.org/abs/2412.18544
- [S15] Diebold, Mariano. *Comparing Predictive Accuracy.* Journal of Business & Economic Statistics (1995). https://doi.org/10.1080/07350015.1995.10524599
- [S16] OpenRouter model catalog, `GET https://openrouter.ai/api/v1/models`, retrieved 2026-11-07.
- [S17] OpenRouter docs, Reasoning tokens. https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
- [S18] OpenRouter docs, Web search plugin. https://openrouter.ai/docs/guides/features/plugins/web-search
