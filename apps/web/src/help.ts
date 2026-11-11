export const helpTopics = {
  events: {
    title: "Events and outcomes",
    summary: "How events work",
    guideLabel: "Read the events guide",
    intro: "Creating an event saves the question and its resolution rules. Open the event and choose Run judgment to request a prediction; creating it alone does not run the models.",
    notes: [
      ["Define a testable question", "Use a Yes or No question, a deadline and a source that will settle the outcome. For example: Will the central bank raise its policy rate at its December meeting? Say exactly which rate and which announcement count."],
      ["Bind the right market", "An optional Polymarket Market ID links the exact binary market to this event. Its price can supply the starting probability. A related market found in search is not enough; check that its question and resolution rules match."],
      ["Record what happened", "After the event resolves, choose Record outcome and supply Yes or No, the resolution time and a source URL. Correct mistakes with Update outcome. A completed prediction is not a resolved event."],
      ["An empty Events page", "Events are created manually or seeded from watchlist candidates. Historical benchmarks live under Evaluation and do not populate this list. The list also depends on which API and database the workspace is using."],
    ],
  },
  predictions: {
    title: "Reading a prediction",
    summary: "How to read a prediction",
    guideLabel: "Read the prediction guide",
    intro: "The percentage is the estimated chance of Yes under the event’s resolution rules. The range shows variation across the ensemble’s models, not a validated statistical confidence interval.",
    notes: [
      ["Prior → evidence → final", "The prior is the starting probability: the bound market’s price when available, then an observed base rate for similar events, then a model estimate without evidence. Evidence moves the forecast from that starting point; calibration may adjust it afterward."],
      ["Judges and models", "Official records, open web research and community signal are evidence-reading roles. Each role can use several models. They are not independent votes: shared evidence, freshness and disagreement affect how their readings are combined."],
      ["A neutral judge", "A judge with no relevant evidence contributes no directional update. A neutral 50% reading on its card does not mean the overall event has a 50% chance. Excluded model samples do not contribute to that judge’s result."],
      ["Read the sources", "Evidence flow shows what was retrieved, rated and kept. Supporting citations let you inspect the sources. A result found through official search can still be a web source; source family describes the publisher. Check Conflicts and gaps even when a run completed."],
      ["Understand the status", "Queued means waiting for a worker; running means processing. Completed means a trace was saved, not that the prediction is correct. Insufficient evidence means the evidence checks did not pass. Failed means the run could not finish; inspect its execution log."],
      ["Run again", "A new judgment creates a new forecast using the current evidence and leaves earlier traces in the history. In live mode it can make paid search and model calls. Read the evaluation time before comparing forecasts."],
    ],
  },
  watchlists: {
    title: "Discovering events with watchlists",
    summary: "How watchlists work",
    guideLabel: "Read the watchlist guide",
    intro: "Watchlists search for candidate events using your keywords, jurisdictions and selected sources. Review a candidate and seed an event before requesting a prediction.",
    notes: [
      ["Discovery is a starting point", "A headline is not yet a forecast question. When seeding an event, add a clear Yes or No question, resolution criteria, deadline and entities. Seeding does not automatically run a judgment."],
      ["Cadence and costs", "Discovery can run on demand or on an hourly, daily or weekly schedule. Live discovery uses paid search calls. Check the schedule and next run on the watchlist detail page; cadence cannot currently be edited after creation."],
      ["Partial results", "If a source fails, the page reports it alongside any candidates from successful sources. No candidates does not prove that no relevant event exists; review keywords and source coverage."],
    ],
  },
  evaluation: {
    title: "Evaluating historical forecasts",
    summary: "How evaluation works",
    guideLabel: "Read the evaluation guide",
    intro: "Evaluation replays resolved benchmark markets at cutoffs before their scheduled end dates. It compares forecasting approaches on known outcomes; it does not create live events.",
    notes: [
      ["Import, select, replay", "Import a benchmark set, select its baselines and cutoffs, then launch a run. Model baselines make paid calls in live mode. Progress is saved as each market finishes; Resume on a failed run reuses stored forecasts."],
      ["Compare the same sample", "Base rate only uses the starting base-rate estimate; Polymarket only uses the stored market price. Model without Polymarket and model with Polymarket show the effect of market information. Use the paired comparison so each baseline is scored on the same market and cutoff pairs."],
      ["Brier score and difference", "Brier score is the average squared error: lower is better, zero is perfect. A 70% forecast scores 0.09 if Yes happens and 0.49 if No happens. A negative Brier difference from Polymarket favors the baseline. An interval crossing zero does not show a clear advantage."],
      ["Other scorecard terms", "Log loss penalizes confident mistakes heavily; lower is better. The reliability chart compares forecast probabilities with observed Yes frequencies. Small bins and few markets make both scores and charts unstable."],
      ["Replay limits", "Replay searches today’s web and filters by dates; it is not an archived view of everything available at the cutoff. Even an Exact fidelity label does not guarantee a leakage-free historical test. Read replay warnings and sample counts before treating results as evidence of live performance."],
    ],
  },
  calibration: {
    title: "Learning from resolved outcomes",
    summary: "How calibration works",
    guideLabel: "Read the calibration guide",
    intro: "Retrain snapshot learns from stored, resolved forecasts. It does not collect new evidence or approve the result. Only the newest approved snapshot is used for new judgments.",
    notes: [
      ["Training sources", "Training can include live judgments with recorded outcomes and historical replay forecasts. Several horizons of the same market count as one group for the sample-size regime and held-out split. The snapshot shows both forecast rows and distinct markets or events."],
      ["Identity and cold start", "Below 20 resolved groups, the calibration map stays identity: it leaves the incoming probability unchanged. Approval alone does not make an identity map calibrated. More forecasts of the same market do not replace more independent outcomes."],
      ["Held-out check", "The check fits a map on some markets and scores it on other markets, comparing its Brier score with leaving the probabilities unchanged. Lower is better. A non-identity map without demonstrated improvement requires an explicit override to approve; an override does not establish quality."],
      ["What approval changes", "A snapshot also carries judge weights, base rates and market trust parameters. Approval affects future judgments; it does not rewrite saved traces. Market trust is fitted separately and needs at least 40 distinct resolved benchmark markets."],
    ],
  },
  runtime: {
    title: "Following a run",
    summary: "How to follow runtime activity",
    guideLabel: "Read the runtime guide",
    intro: "Runtime is the activity timeline across judgments. Filter by run, stage or severity, then open the judgment to inspect its saved trace and execution log.",
    notes: [
      ["Warnings versus failures", "A warning can describe a fallback or a missing source while the rest of the run succeeds. A failed run has stopped. Check the last stage and error before starting another paid run."],
      ["Waiting for progress", "Queued work needs an available worker. Running work may spend time on search or model calls without a new log entry. The workspace polls for updates; a quiet timeline alone does not prove that a run is stuck."],
      ["Limited history", "The runtime feed is bounded. Use the judgment’s own execution log for its recorded stages rather than assuming the feed contains every historical entry."],
    ],
  },
  troubleshooting: {
    title: "Troubleshooting and costs",
    summary: "Workspace help",
    guideLabel: "Read workspace help",
    intro: "Browsing saved events, traces and this guide does not launch predictions. Run judgment, Run again, model evaluation and live discovery can start paid work.",
    notes: [
      ["API ready and Live mode", "API ready reports service readiness. Live mode describes evidence adapters, not whether the judge uses real models or a deterministic test backend. The judge backend is configured separately."],
      ["Nothing appears", "Clear any list filter, check the API address in the sidebar and check readiness. A different API or database can have different events. Benchmark imports appear under Evaluation, not Events."],
      ["API unreachable or not ready", "The web page can load while its backend is unavailable. Check that the API and its dependencies are running and that the web app points to the intended API. This guide remains available while the API is offline."],
      ["Before spending more", "Review existing traces and logs first. Search or model failures can leave a partial result. Scheduled watchlist discovery may spend in the background when enabled; an operator can disable it in the runtime configuration."],
    ],
  },
} as const;

export type HelpTopic = keyof typeof helpTopics;
