# Using Cassandra

Cassandra turns a well-defined Yes/No event into a probability with a trace of the evidence and model readings behind it. It is a research workspace: a completed run means a result was saved, not that the forecast is correct.

The web app includes this workflow under **Help**, with expandable guidance at the top of Events, Watchlists, Judgments, Runtime, Evaluation and Calibration. Help is available even when the API is offline. Local setup is in [README.md](../README.md); request and response contracts are in [api-reference.md](api-reference.md).

## Create and forecast an event

1. Open **Events → Create event**.
2. Write one question that can resolve to Yes or No. Specify the deadline, what counts as each outcome, and which source will settle it.
3. Add the people, organizations or places to search for as comma-separated **Entities**.
4. Optionally select a **Reference Class** for the base rate. Leave it empty if none fits.
5. Optionally bind a **Polymarket Market ID**. Use the ID of the exact binary market, not a URL or event slug. Match the market's question and resolution rules to your event.
6. Save the event, open it, then choose **Run judgment**. Saving an event alone does not request a prediction.
7. Follow the queued/running state, then open the trace. Running again creates another judgment and preserves the previous ones.

Enter deadlines in your local time; the workspace displays saved dates in UTC. Market Symbols are optional tickers used for market evidence lookup. They do not bind a Polymarket price as the prior.

For example, “Will the central bank raise its policy rate at the December meeting?” needs rules naming the rate, the meeting, the official announcement and how a postponed decision resolves. A broad headline such as “Interest rates are changing” is not sufficient.

## Read the result

| Label | Meaning |
| --- | --- |
| Probability | Estimated chance of **Yes**, under the event's rules, at the recorded evaluation time. |
| Prior | Starting probability: the bound market price when available, then an observed reference-class base rate, then a model estimate made without evidence. Related markets found in search cannot set it. |
| Final | Probability after evidence aggregation, disagreement shrinkage and any calibration adjustment. |
| Range | Spread across ensemble model outputs. It is not a validated statistical confidence interval. |
| Identity calibration | The calibration map leaves the incoming probability unchanged. An approved identity snapshot still makes no probability calibration adjustment. |
| Neutral judge | A role without relevant evidence makes no directional update. Its 50% card is not a 50% prediction for the event as a whole. |

**How the forecast moved** shows the path from prior to final. Official records, open web research and community signal are evidence-reading roles; each can use several models. They are not independent votes. Aggregation accounts for weights, evidence overlap, freshness and disagreement. Contradictory model samples can be excluded; a failed judge can abstain while other judges continue.

**Model agreement** shows individual model readings. **Evidence flow** shows retrieved, rated and retained evidence. Open **Supporting citations** to inspect the original sources. A publisher's source family is distinct from the provider that found it: a web article returned by official search remains a web article.

Read **Conflicts and gaps**, **Pipeline** and the **Execution log** before relying on a result. A forecast can complete with missing sources or a fallback. A narrow model range does not establish that the sources are complete or accurate.

## Follow run states

| State | Next step |
| --- | --- |
| Queued | Wait for the worker. If it persists, inspect worker and queue availability. |
| Running | The system is collecting evidence or waiting for models. A quiet log alone does not prove the run is stuck. |
| Completed | Inspect the saved trace, citations and gaps. This does not resolve the event. |
| Insufficient evidence | Inspect coverage and missing evidence before requesting another run. |
| Failed | Inspect the error and execution log before retrying. |

**Runtime** provides a filterable, bounded activity feed across judgments. Open an individual judgment for its recorded execution stages. Repeated clicks on Run again create additional work and can incur further costs.

## Discover candidates with watchlists

Create a watchlist with keywords, jurisdictions, source selections and an hourly, daily or weekly cadence. On its detail page, inspect the schedule, next run and any source failures. Run discovery on demand when needed.

Review a candidate, choose to seed an event, and complete its question, rules, deadline and entities. Seeding does not run a prediction. Partial source failures may still produce candidates. No results do not prove there are no relevant events. Cadence cannot currently be changed after creation.

Live discovery uses paid search calls. Scheduled discovery is enabled by default; set `CASSANDRA_DISCOVERY_SCHEDULE=off` for a live API that should not spend on discovery in the background.

## Evaluate historical forecasts

**Evaluation** contains resolved benchmark markets, separate from Events. Import a set, choose baselines and cutoffs, and launch a queued replay. Cutoffs count back from each market's scheduled end date. A run saves forecasts as markets finish; **Resume** reuses saved forecasts after a failure.

The baselines compare a base-rate estimate, Polymarket's stored price, a model without Polymarket information and a model with it. A baseline with no forecasts has no score. The **paired** comparison scores baselines only on shared market/cutoff pairs.

- **Brier score** is average squared error, with zero best. A 70% Yes forecast scores `(0.7 - 1)² = 0.09` if Yes occurs and `(0.7 - 0)² = 0.49` if No occurs.
- **Brier difference from Polymarket** is the baseline score minus Polymarket's. Negative favors the baseline. The interval resamples markets together with their horizons; crossing zero does not show a clear advantage.
- **Log loss** penalizes confident mistakes heavily; lower is better.
- **Reliability** compares predicted probabilities with observed Yes frequencies. Small bins and few markets make it unstable.

Replay uses present-day search with date filtering, not a complete archived view of the web at the cutoff. An **Exact** fidelity label does not remove that limitation. Inspect replay warnings, paired sample size and distinct market counts; a small historical advantage is not evidence of proven live performance.

## Record outcomes and retrain

When an event resolves, use **Record outcome** on the event page. Supply Yes/No, the resolution time and a source URL. **Update outcome** corrects the recorded resolution.

**Retrain snapshot** uses stored resolved live judgments and, by default, replay forecasts. It does not generate new evidence. The API option `{"includeReplay": false}` restricts training to live judgments. The snapshot reports both training rows and distinct event/market groups. Several horizons of one market count as one group for sample-size regimes and held-out folds.

- Fewer than **20 resolved groups**: cold start, identity map.
- **20–99 groups**: warming, logistic calibration.
- **100 or more groups**: steady; isotonic calibration when there is enough prediction and outcome variation, otherwise logistic.
- Market trust has a separate minimum of **40 distinct resolved benchmark markets**.

Inspect the held-out comparison: the map is fitted on some markets and scored on other markets against leaving probabilities unchanged. A non-identity map without demonstrated improvement requires an explicit approval override. An override does not demonstrate quality.

Only the newest approved snapshot is used for new judgments. It also carries learned judge weights, base rates and market trust parameters. Retraining alone does not activate it, and approval does not rewrite old traces.

To generate replay training data, use the paid calibration harness described in [README.md](../README.md#evaluation-and-learning). Its default invocation prints a free plan; `CALIBRATION_CONFIRM=yes` starts the actual cycle. The harness does not approve a snapshot.

## Empty pages, connectivity and costs

If Events is empty, clear its filter, check the API address in the sidebar, and confirm that the API points to the intended database. Benchmark imports appear under Evaluation, not Events. A separate database has its own events and snapshots; switching databases does not move or delete the original records.

The web server can be running while the API is unreachable. **API ready** describes backend readiness. The sidebar refreshes health and readiness every 10 seconds while the tab is active, and when you return to the tab or reconnect. If health cannot be reached, it hides the previously reported mode rather than presenting it as current. **Live mode** describes evidence adapters; the judge backend is configured separately with `CASSANDRA_JUDGE_LLM`. For live model calls it must be set to the intended real backend, such as `openrouter`, rather than `fake`.

Browsing saved data and Help does not launch predictions. Live judgments, model replay baselines and discovery can incur search and model costs. Check logs before retrying failed work. For startup commands, service configuration and access control, use [Quick start](../README.md#quick-start).
