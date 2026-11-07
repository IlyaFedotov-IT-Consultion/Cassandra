import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ChangeEvent,
  useEffect,
  useState,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  type EvaluationRun,
  createEvaluationRun,
  fetchEvaluationRun,
  importPolymarketBenchmarks,
  listBenchmarkMarkets,
  listBenchmarkSets,
  listEvaluationPredictions,
  listEvaluationRuns,
} from "../api";
import {
  ReliabilityChart,
  type ReliabilitySeries,
} from "../components/charts";
import {
  EmptyState,
  InlineError,
  LoadingState,
  MetricTile,
  PageIntro,
  SectionCard,
  StatusPill,
  useToast,
} from "../components/ui";
import {
  formatDateTime,
  formatDecimal,
  humanizeToken,
} from "../format";

export const ALL_BASELINES = [
  { value: "base_rate_only", label: "Base rate only" },
  { value: "polymarket_only", label: "Polymarket only" },
  { value: "model_without_polymarket", label: "Model without Polymarket" },
  { value: "model_with_polymarket", label: "Model with Polymarket" },
] as const;

export function EvaluationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [benchmarkImportDraft, setBenchmarkImportDraft] = useState("");
  const [selectedBenchmarkSetId, setSelectedBenchmarkSetId] = useState("");
  const [selectedBaselines, setSelectedBaselines] = useState<string[]>(
    ALL_BASELINES.map((b) => b.value),
  );
  const benchmarkSetsQuery = useQuery({
    queryKey: ["benchmark-sets"],
    queryFn: listBenchmarkSets,
  });
  const benchmarkMarketsQuery = useQuery({
    queryKey: ["benchmark-markets", selectedBenchmarkSetId],
    queryFn: () => listBenchmarkMarkets(selectedBenchmarkSetId),
    enabled: Boolean(selectedBenchmarkSetId),
  });
  const runsQuery = useQuery({
    queryKey: ["evaluation-runs"],
    queryFn: listEvaluationRuns,
  });
  const runMutation = useMutation({
    mutationFn: createEvaluationRun,
    onSuccess(run) {
      pushToast("Evaluation run created.");
      navigate(`/evaluation/runs/${run.id}`);
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to create evaluation run", "error");
    },
  });
  const importMutation = useMutation({
    mutationFn: importPolymarketBenchmarks,
    async onSuccess(result, benchmarkSetId) {
      await queryClient.invalidateQueries({ queryKey: ["benchmark-sets"] });
      const importedBenchmarkSetId = benchmarkSetId || result.markets[0]?.benchmarkSetId || "";

      if (importedBenchmarkSetId) {
        setSelectedBenchmarkSetId(importedBenchmarkSetId);
      }

      setBenchmarkImportDraft("");
      pushToast(`Imported ${result.imported} benchmark market${result.imported === 1 ? "" : "s"}.`);
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to import benchmarks", "error");
    },
  });

  useEffect(() => {
    if (!selectedBenchmarkSetId && benchmarkSetsQuery.data?.[0]?.benchmarkSetId) {
      setSelectedBenchmarkSetId(benchmarkSetsQuery.data[0].benchmarkSetId);
    }
  }, [benchmarkSetsQuery.data, selectedBenchmarkSetId]);

  if (benchmarkSetsQuery.isLoading || runsQuery.isLoading) {
    return <LoadingState label="Loading evaluation workspace…" />;
  }

  if (benchmarkSetsQuery.isError || runsQuery.isError) {
    return (
      <InlineError
        message={
          benchmarkSetsQuery.error instanceof Error
            ? benchmarkSetsQuery.error.message
            : runsQuery.error instanceof Error
              ? runsQuery.error.message
              : "Unable to load evaluation workspace"
        }
      />
    );
  }

  const benchmarkSets = benchmarkSetsQuery.data ?? [];
  const benchmarkMarkets = benchmarkMarketsQuery.data ?? [];
  const runs = runsQuery.data ?? [];

  return (
    <div className="page-stack">
      <PageIntro
        title="Evaluation"
        description="Review benchmark sets, launch replay runs, and inspect the most recent scorecards."
      />
      {runMutation.isError ? (
        <InlineError
          message={runMutation.error instanceof Error ? runMutation.error.message : "Unable to create evaluation run"}
        />
      ) : null}
      {importMutation.isError ? (
        <InlineError
          message={importMutation.error instanceof Error ? importMutation.error.message : "Unable to import benchmarks"}
        />
      ) : null}
      <section className="two-up">
        <SectionCard title="Benchmark Sets" kicker="Replay scope">
          <div className="section-card__toolbar">
            <div className="inline-form">
              <input
                aria-label="Benchmark set id"
                placeholder="Optional benchmark set id"
                value={benchmarkImportDraft}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setBenchmarkImportDraft(event.target.value)
                }
              />
              <button
                className="ghost-button"
                type="button"
                disabled={importMutation.isPending}
                onClick={() => importMutation.mutate(benchmarkImportDraft.trim() || undefined)}
              >
                {importMutation.isPending ? "Importing…" : "Import benchmarks"}
              </button>
            </div>
            <p className="helper-text">
              Fixture mode seeds a local resolved market pack. Live mode pulls recently resolved
              Polymarket markets into the selected benchmark set.
            </p>
          </div>
          {benchmarkSets.length === 0 ? (
            <EmptyState title="No benchmark sets yet" body="Import benchmarks before launching an evaluation run." />
          ) : (
            <div className="list-stack">
              {benchmarkSets.map((benchmarkSet) => (
                <label key={benchmarkSet.benchmarkSetId} className="radio-row">
                  <input
                    checked={selectedBenchmarkSetId === benchmarkSet.benchmarkSetId}
                    name="benchmarkSetId"
                    type="radio"
                    onChange={() => setSelectedBenchmarkSetId(benchmarkSet.benchmarkSetId)}
                  />
                  <span>
                    <strong>{benchmarkSet.benchmarkSetId}</strong>
                    <small>
                      {benchmarkSet.marketCount} markets · {benchmarkSet.themes.join(", ")}
                    </small>
                    <small>
                      {formatDateTime(benchmarkSet.earliestResolvedAt)} to{" "}
                      {formatDateTime(benchmarkSet.latestResolvedAt)}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="baseline-picker">
            <p className="helper-text">Select baselines to include in the evaluation run:</p>
            {ALL_BASELINES.map((baseline) => (
              <label key={baseline.value} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectedBaselines.includes(baseline.value)}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    setSelectedBaselines((current) =>
                      event.target.checked
                        ? [...current, baseline.value]
                        : current.filter((b) => b !== baseline.value),
                    );
                  }}
                />
                <span>{baseline.label}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={!selectedBenchmarkSetId || selectedBaselines.length === 0 || runMutation.isPending || importMutation.isPending}
            onClick={() => runMutation.mutate({ benchmarkSetId: selectedBenchmarkSetId, baselines: selectedBaselines })}
          >
            {runMutation.isPending ? "Launching…" : "Run evaluation"}
          </button>
        </SectionCard>
        <SectionCard title="Recent Evaluation Runs" kicker="History">
          {runs.length === 0 ? (
            <EmptyState title="No evaluation runs yet" body="Launch a run from the selected benchmark set." />
          ) : (
            <div className="list-stack">
              {runs.map((run) => {
                const metrics = run.overallMetrics as Record<string, unknown> | undefined;
                const benchmarkCount = metrics && "benchmarkCount" in metrics ? Number(metrics.benchmarkCount) : 0;
                const predictionCount = metrics && "predictionCount" in metrics ? Number(metrics.predictionCount) : 0;
                return (
                  <Link key={run.id} className="list-row" to={`/evaluation/runs/${run.id}`}>
                    <div>
                      <strong>{formatDateTime(run.createdAt)}</strong>
                      <p>
                        {run.baselines.map(humanizeToken).join(", ")}
                      </p>
                    </div>
                    <div className="list-row__tail">
                      <span>{benchmarkCount} benchmarks · {predictionCount} predictions</span>
                      <small>{humanizeToken(run.replayFidelity)}</small>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </SectionCard>
      </section>
      <SectionCard title="Benchmark Preview" kicker="Selected set">
        {!selectedBenchmarkSetId ? (
          <EmptyState
            title="No benchmark set selected"
            body="Import or choose a benchmark set to inspect its resolved markets before running a replay."
          />
        ) : benchmarkMarketsQuery.isLoading ? (
          <LoadingState label="Loading benchmark markets…" />
        ) : benchmarkMarketsQuery.isError ? (
          <InlineError
            message={
              benchmarkMarketsQuery.error instanceof Error
                ? benchmarkMarketsQuery.error.message
                : "Unable to load benchmark markets"
            }
          />
        ) : benchmarkMarkets.length === 0 ? (
          <EmptyState
            title="No resolved markets in this set"
            body="Import or refresh the selected benchmark set before launching an evaluation run."
          />
        ) : (
          <div className="list-stack">
            <p className="helper-text">
              Showing {Math.min(5, benchmarkMarkets.length)} of {benchmarkMarkets.length} resolved
              markets from <strong>{selectedBenchmarkSetId}</strong>.
            </p>
            {benchmarkMarkets.slice(0, 5).map((market) => (
              <article key={market.id} className="list-row">
                <div>
                  <strong>{market.title}</strong>
                  <p>
                    {humanizeToken(market.theme)} · Resolved {formatDateTime(market.resolvedAt)}
                  </p>
                </div>
                <div className="list-row__tail">
                  <StatusPill value={market.resolvedValue ? "yes" : "no"} />
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

interface BaselineMetrics {
  brierScore: number;
  logLoss: number;
  averageAbsoluteError: number;
  expectedCalibrationError?: number;
  winRateVsPolymarket?: number;
  sampleSize: number;
}

type MetricKey = "brierScore" | "logLoss" | "expectedCalibrationError" | "averageAbsoluteError";

const LOWER_IS_BETTER: Array<{ key: MetricKey; label: string }> = [
  { key: "brierScore", label: "Brier score" },
  { key: "logLoss", label: "Log loss" },
  { key: "expectedCalibrationError", label: "Calibration error (ECE)" },
  { key: "averageAbsoluteError", label: "Avg abs error" },
];

const baselineOrder: string[] = ALL_BASELINES.map((baseline) => baseline.value);

function baselineLabel(baseline: string) {
  return ALL_BASELINES.find((entry) => entry.value === baseline)?.label ?? humanizeToken(baseline);
}

function readBaselineMetrics(value: unknown): Record<string, BaselineMetrics> | null {
  return value && typeof value === "object" ? (value as Record<string, BaselineMetrics>) : null;
}

function sortByBaselineOrder<T>(entries: Array<[string, T]>) {
  const rank = (baseline: string) => {
    const index = baselineOrder.indexOf(baseline);
    return index === -1 ? baselineOrder.length : index;
  };
  return [...entries].sort(([left], [right]) => rank(left) - rank(right));
}

function ScoreTable({ label, metrics }: { label: string; metrics: Record<string, BaselineMetrics> }) {
  const rows = sortByBaselineOrder(Object.entries(metrics));
  const best = new Map<MetricKey, number>();
  if (rows.length > 1) {
    for (const { key } of LOWER_IS_BETTER) {
      const values = rows.map(([, row]) => row[key]).filter((value): value is number => typeof value === "number");
      if (values.length > 1 && Math.max(...values) > Math.min(...values)) {
        best.set(key, Math.min(...values));
      }
    }
  }

  return (
    <div className="table-shell">
      <table className="data-table">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Baseline</th>
            {LOWER_IS_BETTER.map(({ key, label: columnLabel }) => (
              <th key={key} scope="col" className="data-table__number">
                {columnLabel}
              </th>
            ))}
            <th scope="col" className="data-table__number">Beats market</th>
            <th scope="col" className="data-table__number">Predictions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([baseline, row]) => (
            <tr key={baseline}>
              <th scope="row">{baselineLabel(baseline)}</th>
              {LOWER_IS_BETTER.map(({ key }) => {
                const value = row[key];
                const isBest = typeof value === "number" && best.get(key) === value;
                return (
                  <td key={key} className={isBest ? "data-table__number data-table__best" : "data-table__number"}>
                    <span>{typeof value === "number" ? formatDecimal(value) : "n/a"}</span>
                    {isBest ? <span className="best-tag">Best</span> : null}
                  </td>
                );
              })}
              <td className="data-table__number">
                {baseline === "polymarket_only" || typeof row.winRateVsPolymarket !== "number"
                  ? "n/a"
                  : `${Math.round(row.winRateVsPolymarket * 100)}%`}
              </td>
              <td className="data-table__number">{row.sampleSize}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Prediction = Awaited<ReturnType<typeof listEvaluationPredictions>>[number];

const RELIABILITY_BINS = 5;

export function buildReliabilitySeries(predictions: Prediction[]): ReliabilitySeries[] {
  const byBaseline = new Map<string, Prediction[]>();
  for (const prediction of predictions) {
    if (prediction.outcome === null) {
      continue;
    }
    byBaseline.set(prediction.baseline, [...(byBaseline.get(prediction.baseline) ?? []), prediction]);
  }

  return sortByBaselineOrder([...byBaseline.entries()]).map(([baseline, rows]) => {
    const bins = Array.from({ length: RELIABILITY_BINS }, () => ({ predicted: 0, observed: 0, count: 0 }));
    for (const row of rows) {
      const index = Math.min(Math.floor(row.predictedProbability * RELIABILITY_BINS), RELIABILITY_BINS - 1);
      bins[index]!.predicted += row.predictedProbability;
      bins[index]!.observed += row.outcome ? 1 : 0;
      bins[index]!.count += 1;
    }
    const slotIndex = baselineOrder.indexOf(baseline);
    return {
      key: baseline,
      label: baselineLabel(baseline),
      slot: slotIndex === -1 ? 4 : slotIndex + 1,
      bins: bins
        .filter((bin) => bin.count > 0)
        .map((bin) => ({ predicted: bin.predicted / bin.count, observed: bin.observed / bin.count, count: bin.count })),
    };
  });
}

type SliceResult = EvaluationRun["sliceResults"][number];

const HORIZON = /^(\d+)([hdwm])$/;
const HOURS_PER_UNIT: Record<string, number> = { h: 1, d: 24, w: 168, m: 720 };

/**
 * Slices arrive as flat rows keyed by horizon ("7d"), theme ("elections") or source
 * configuration (a baseline name, which only repeats the overall scores). Pivot them into
 * one row per slice with a cell per baseline, horizons longest first, themes alphabetical.
 */
export function groupSlices(sliceResults: SliceResult[]) {
  const groups = new Map<string, Map<string, { key: string; label: string; order: number; cells: Record<string, SliceResult> }>>();
  for (const slice of sliceResults) {
    if (baselineOrder.includes(slice.sliceKey)) {
      continue;
    }
    const horizon = HORIZON.exec(slice.sliceKey);
    const dimension = horizon ? "Horizon" : "Theme";
    const rows = groups.get(dimension) ?? new Map();
    const row = rows.get(slice.sliceKey) ?? {
      key: slice.sliceKey,
      label: horizon ? slice.sliceKey : humanizeToken(slice.sliceKey),
      order: horizon ? -Number(horizon[1]) * HOURS_PER_UNIT[horizon[2]!]! : 0,
      cells: {},
    };
    row.cells[slice.baseline] = slice;
    rows.set(slice.sliceKey, row);
    groups.set(dimension, rows);
  }
  return ["Horizon", "Theme"]
    .filter((dimension) => groups.has(dimension))
    .map((dimension) => ({
      dimension,
      rows: [...groups.get(dimension)!.values()].sort(
        (left, right) => left.order - right.order || left.label.localeCompare(right.label),
      ),
    }));
}

export interface WarningGroup {
  key: string;
  reason: string;
  baseline: string | null;
  occurrences: Array<{ marketId: string; cutoffAt: string } | null>;
}

const SKIPPED_WARNING = /^Skipped (\S+) for (\S+) at (\S+): (.+)$/;

/** Collapse one-line-per-prediction replay warnings into one entry per baseline and reason. */
export function groupReplayWarnings(warnings: string[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const warning of warnings) {
    const match = SKIPPED_WARNING.exec(warning);
    const baseline = match ? match[1]! : null;
    const reason = match ? match[4]! : warning;
    const key = `${baseline ?? ""}|${reason}`;
    const group = groups.get(key) ?? { key, reason, baseline, occurrences: [] };
    group.occurrences.push(match ? { marketId: match[2]!, cutoffAt: match[3]! } : null);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.occurrences.length - left.occurrences.length);
}

function sentenceCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function EvaluationRunPage() {
  const { runId } = useParams();
  const runQuery = useQuery({
    queryKey: ["evaluation-run", runId],
    queryFn: () => fetchEvaluationRun(runId ?? ""),
    enabled: Boolean(runId),
  });
  const predictionsQuery = useQuery({
    queryKey: ["evaluation-predictions", runId],
    queryFn: () => listEvaluationPredictions(runId ?? ""),
    enabled: Boolean(runId),
  });
  const marketsQuery = useQuery({
    queryKey: ["benchmark-markets", runQuery.data?.benchmarkSetId],
    queryFn: () => listBenchmarkMarkets(runQuery.data?.benchmarkSetId ?? ""),
    enabled: Boolean(runQuery.data?.benchmarkSetId),
  });

  if (!runId) {
    return <InlineError message="Missing evaluation run id" />;
  }

  if (runQuery.isLoading || predictionsQuery.isLoading) {
    return <LoadingState label="Loading evaluation run…" />;
  }

  if (runQuery.isError || predictionsQuery.isError) {
    return (
      <InlineError
        message={
          runQuery.error instanceof Error
            ? runQuery.error.message
            : predictionsQuery.error instanceof Error
              ? predictionsQuery.error.message
              : "Unable to load evaluation run"
        }
      />
    );
  }

  const run = runQuery.data as EvaluationRun;
  const predictions = predictionsQuery.data ?? [];
  const marketTitleMap = new Map((marketsQuery.data ?? []).map((market) => [market.id, market.title]));
  const overall = (run.overallMetrics ?? {}) as Record<string, unknown>;
  const byBaseline = readBaselineMetrics(overall.byBaseline);
  const paired =
    overall.paired && typeof overall.paired === "object"
      ? (overall.paired as { sampleSize?: number; byBaseline?: unknown })
      : null;
  const pairedByBaseline = readBaselineMetrics(paired?.byBaseline);
  const benchmarkCount = typeof overall.benchmarkCount === "number" ? overall.benchmarkCount : 0;
  const predictionCount = typeof overall.predictionCount === "number" ? overall.predictionCount : predictions.length;
  const reliability = buildReliabilitySeries(predictions);
  const sliceGroups = groupSlices(run.sliceResults);
  const sliceBaselines = sortByBaselineOrder(
    [...new Set(sliceGroups.flatMap((group) => group.rows.flatMap((row) => Object.keys(row.cells))))].map(
      (baseline) => [baseline, null] as [string, null],
    ),
  ).map(([baseline]) => baseline);
  const warningGroups = groupReplayWarnings(run.leakageWarnings);

  return (
    <div className="page-stack">
      <PageIntro
        title="Evaluation run"
        description={`Replayed on ${formatDateTime(run.createdAt)} at the ${run.cutoffs.join(", ")} cutoffs before each market resolved.`}
        returnLink={{
          to: "/evaluation",
          label: "Back to evaluation",
        }}
      />
      <ul className="fact-row">
        <li>
          <span>Benchmark set</span>
          <strong>{run.benchmarkSetId}</strong>
        </li>
        <li>
          <span>Markets</span>
          <strong>{benchmarkCount}</strong>
        </li>
        <li>
          <span>Predictions</span>
          <strong>{predictionCount}</strong>
        </li>
        <li>
          <span>Replay fidelity</span>
          <strong>{humanizeToken(run.replayFidelity)}</strong>
        </li>
      </ul>

      <SectionCard title="Scores">
        {pairedByBaseline && Object.keys(pairedByBaseline).length > 0 ? (
          <>
            <p className="helper-text">
              {paired?.sampleSize ?? 0} market-cutoff pairs scored by every baseline. Lower is better; the best score in
              each column is marked.
            </p>
            <ScoreTable label="Paired comparison" metrics={pairedByBaseline} />
            {byBaseline ? (
              <details className="disclosure">
                <summary>All predictions (sample sizes differ by baseline)</summary>
                <ScoreTable label="All predictions" metrics={byBaseline} />
              </details>
            ) : null}
          </>
        ) : byBaseline && Object.keys(byBaseline).length > 0 ? (
          <>
            <p className="helper-text">
              This run predates paired scoring, so baselines may be scored on different markets.
            </p>
            <ScoreTable label="Scores by baseline" metrics={byBaseline} />
          </>
        ) : (
          <EmptyState title="No scores recorded" body="This run did not record per-baseline metrics." />
        )}
      </SectionCard>

      <SectionCard title="Reliability">
        {reliability.length === 0 ? (
          <EmptyState title="No resolved predictions" body="Reliability needs predictions on markets that have resolved." />
        ) : (
          <div className="reliability">
            <ReliabilityChart series={reliability} />
            <div className="reliability__notes">
              <p className="helper-text">
                Each point groups predictions into a 20-point probability band. Points on the diagonal mean the baseline
                was right as often as it said it would be.
              </p>
              <details className="disclosure">
                <summary>Show as table</summary>
                <div className="table-shell">
                  <table className="data-table">
                    <caption>Reliability bins</caption>
                    <thead>
                      <tr>
                        <th scope="col">Baseline</th>
                        <th scope="col" className="data-table__number">Mean predicted</th>
                        <th scope="col" className="data-table__number">Observed</th>
                        <th scope="col" className="data-table__number">Predictions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reliability.flatMap((series) =>
                        series.bins.map((bin) => (
                          <tr key={`${series.key}-${bin.predicted}`}>
                            <th scope="row">{series.label}</th>
                            <td className="data-table__number">{Math.round(bin.predicted * 100)}%</td>
                            <td className="data-table__number">{Math.round(bin.observed * 100)}%</td>
                            <td className="data-table__number">{bin.count}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
            </div>
          </div>
        )}
      </SectionCard>

      {warningGroups.length > 0 ? (
        <SectionCard title="Replay warnings">
          <p className="helper-text">Predictions the replay skipped or flagged for possible post-cutoff information.</p>
          <ul className="note-list">
            {warningGroups.map((group) => {
              const located = group.occurrences.filter(
                (occurrence): occurrence is { marketId: string; cutoffAt: string } => occurrence !== null,
              );
              const count = group.occurrences.length;
              return (
                <li key={group.key} className="note-list__item">
                  <p className="note-list__reason">{sentenceCase(group.reason)}</p>
                  <p className="note-list__count">
                    {group.baseline ? `${baselineLabel(group.baseline)}: ` : ""}
                    {count} prediction{count === 1 ? "" : "s"} {group.baseline ? "skipped" : "affected"}
                  </p>
                  {located.length > 0 ? (
                    <details className="disclosure disclosure--inline">
                      <summary>Affected markets</summary>
                      <ul className="note-list__markets">
                        {located.map((occurrence) => (
                          <li key={`${occurrence.marketId}-${occurrence.cutoffAt}`}>
                            {marketTitleMap.get(occurrence.marketId) ?? occurrence.marketId}, cutoff{" "}
                            {formatDateTime(occurrence.cutoffAt)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}

      {sliceGroups.length > 0 ? (
        <SectionCard title="Scores by slice">
          <p className="helper-text">
            Brier score for each baseline within a forecast horizon or market theme; n is the number of predictions.
          </p>
          <div className="table-shell">
            <table className="data-table">
              <caption>Brier score by slice</caption>
              <thead>
                <tr>
                  <th scope="col">Slice</th>
                  {sliceBaselines.map((baseline) => (
                    <th key={baseline} scope="col" className="data-table__number">
                      {baselineLabel(baseline)}
                    </th>
                  ))}
                </tr>
              </thead>
              {sliceGroups.map((group) => (
                <tbody key={group.dimension}>
                  <tr className="data-table__group">
                    <th scope="colgroup" colSpan={sliceBaselines.length + 1}>
                      {group.dimension}
                    </th>
                  </tr>
                  {group.rows.map((row) => {
                    const scores = sliceBaselines
                      .map((baseline) => row.cells[baseline]?.brierScore)
                      .filter((value): value is number => typeof value === "number");
                    const best =
                      scores.length > 1 && Math.max(...scores) > Math.min(...scores) ? Math.min(...scores) : null;
                    return (
                      <tr key={row.key}>
                        <th scope="row">{row.label}</th>
                        {sliceBaselines.map((baseline) => {
                          const cell = row.cells[baseline];
                          const isBest = cell !== undefined && cell.brierScore === best;
                          return (
                            <td
                              key={baseline}
                              className={isBest ? "data-table__number data-table__best" : "data-table__number"}
                            >
                              {cell ? (
                                <>
                                  <span>{formatDecimal(cell.brierScore)}</span>
                                  {isBest ? <span className="best-tag">Best</span> : null}
                                  <span className="data-table__n">n={cell.sampleSize}</span>
                                </>
                              ) : (
                                "n/a"
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        </SectionCard>
      ) : null}

      <details className="disclosure">
        <summary>Predictions ({predictions.length})</summary>
        {predictions.length === 0 ? (
          <EmptyState title="No predictions stored" body="This evaluation run has no persisted prediction rows." />
        ) : (
          <div className="table-shell">
            <table className="data-table">
              <caption>Predictions</caption>
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col">Theme</th>
                  <th scope="col">Horizon</th>
                  <th scope="col">Baseline</th>
                  <th scope="col" className="data-table__number">Prediction</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {predictions.map((prediction) => (
                  <tr key={prediction.id}>
                    <td>{marketTitleMap.get(prediction.benchmarkMarketId) ?? prediction.benchmarkMarketId}</td>
                    <td>{prediction.theme ? humanizeToken(prediction.theme) : "n/a"}</td>
                    <td>{prediction.horizon ?? "n/a"}</td>
                    <td>{baselineLabel(prediction.baseline)}</td>
                    <td className="data-table__number">{formatDecimal(prediction.predictedProbability)}</td>
                    <td>{prediction.outcome === null ? "Unresolved" : prediction.outcome ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}
