import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useEffect,
  useState,
} from "react";
import {
  approveCalibrationSnapshot,
  fetchCalibrationSnapshot,
  listCalibrationSnapshots,
  retrainCalibrationSnapshot,
} from "../api";
import {
  EmptyState,
  InlineError,
  LoadingState,
  MetricTile,
  PageIntro,
  SectionCard,
  useToast,
} from "../components/ui";
import {
  formatDateTime,
  formatDecimal,
  humanizeToken,
} from "../format";

export function summarizeCalibrationSnapshot(snapshot: Awaited<ReturnType<typeof retrainCalibrationSnapshot>>) {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    trainingWindow: snapshot.trainingWindow,
    metrics: snapshot.metrics,
    weightRegime: snapshot.weightRegime,
    resolvedOutcomeCount: snapshot.resolvedOutcomeCount,
    approved: snapshot.approved,
  };
}

const MIN_RELIABLE_TRACES = 20;

type SnapshotSummary = Awaited<ReturnType<typeof listCalibrationSnapshots>>[number];

/** Mirrors the API's getLatestCalibrationSnapshot: newest approved, else newest. */
export function findSnapshotInUse(snapshots: SnapshotSummary[]) {
  const newestFirst = [...snapshots].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return newestFirst.find((snapshot) => snapshot.approved) ?? newestFirst[0] ?? null;
}

function readMetric(metrics: Record<string, unknown>, key: string) {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatOptionalDecimal(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? formatDecimal(value) : "n/a";
}

function describeCalibration(params: Record<string, unknown>) {
  switch (params.method) {
    case "logistic":
      return `Platt scaling (slope ${formatOptionalDecimal(params.slope)}, intercept ${formatOptionalDecimal(params.intercept)})`;
    case "isotonic":
      return `Isotonic regression (${Array.isArray(params.thresholds) ? params.thresholds.length : 0} steps)`;
    case "identity":
    case undefined:
      return "None yet: probabilities pass through unchanged";
    default:
      return humanizeToken(String(params.method));
  }
}

export function CalibrationPage() {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const snapshotsQuery = useQuery({
    queryKey: ["calibration-snapshots"],
    queryFn: listCalibrationSnapshots,
  });
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const snapshotDetailQuery = useQuery({
    queryKey: ["calibration-snapshot", selectedSnapshotId],
    queryFn: () => fetchCalibrationSnapshot(selectedSnapshotId),
    enabled: Boolean(selectedSnapshotId),
  });
  const approveMutation = useMutation({
    mutationFn: approveCalibrationSnapshot,
    onSuccess(snapshot) {
      queryClient.setQueryData(
        ["calibration-snapshots"],
        (current: ReturnType<typeof listCalibrationSnapshots> extends Promise<infer T> ? T | undefined : never) => {
          const summary = summarizeCalibrationSnapshot(snapshot);
          const remaining = (current ?? []).filter((item) => item.id !== summary.id);
          return [summary, ...remaining];
        },
      );
      queryClient.setQueryData(["calibration-snapshot", snapshot.id], snapshot);
      setSelectedSnapshotId(snapshot.id);
      pushToast("Calibration snapshot approved.");
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to approve calibration", "error");
    },
  });
  const retrainMutation = useMutation({
    mutationFn: retrainCalibrationSnapshot,
    onSuccess(snapshot) {
      queryClient.setQueryData(
        ["calibration-snapshots"],
        (current: ReturnType<typeof listCalibrationSnapshots> extends Promise<infer T> ? T | undefined : never) => {
          const summary = summarizeCalibrationSnapshot(snapshot);
          const remaining = (current ?? []).filter((item) => item.id !== summary.id);
          return [summary, ...remaining];
        },
      );
      queryClient.setQueryData(["calibration-snapshot", snapshot.id], snapshot);
      setSelectedSnapshotId(snapshot.id);
      pushToast("Calibration snapshot retrained.");
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to retrain calibration", "error");
    },
  });

  useEffect(() => {
    if (!selectedSnapshotId && snapshotsQuery.data?.[0]?.id) {
      setSelectedSnapshotId(snapshotsQuery.data[0].id);
    }
  }, [selectedSnapshotId, snapshotsQuery.data]);

  if (snapshotsQuery.isLoading) {
    return <LoadingState label="Loading calibration snapshots…" />;
  }

  if (snapshotsQuery.isError) {
    return <InlineError message={snapshotsQuery.error.message} />;
  }

  const snapshots = snapshotsQuery.data ?? [];
  const inUseId = findSnapshotInUse(snapshots)?.id ?? null;
  const selectedSnapshot =
    snapshotDetailQuery.data ?? snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null;
  const detail = snapshotDetailQuery.data?.id === selectedSnapshot?.id ? (snapshotDetailQuery.data ?? null) : null;
  const metrics = (selectedSnapshot?.metrics ?? {}) as Record<string, unknown>;
  const hasScores = typeof metrics.brierScore === "number";

  return (
    <div className="page-stack">
      <PageIntro
        title="Calibration"
        description="Each snapshot maps raw ensemble probabilities onto observed outcome frequencies. Judgments use the newest approved snapshot, or the newest one when none is approved."
        actions={
          <button type="button" disabled={retrainMutation.isPending} onClick={() => retrainMutation.mutate()}>
            {retrainMutation.isPending ? "Retraining…" : "Retrain snapshot"}
          </button>
        }
      />
      {retrainMutation.isError ? (
        <InlineError
          message={
            retrainMutation.error instanceof Error ? retrainMutation.error.message : "Unable to retrain calibration"
          }
        />
      ) : null}
      <section className="split-view">
        <SectionCard title="Snapshot history">
          {snapshots.length === 0 ? (
            <EmptyState title="No snapshots yet" body="Retrain to create the first calibration snapshot." />
          ) : (
            <ul className="snapshot-list" aria-label="Snapshot history">
              {snapshots.map((snapshot) => {
                const brier = readMetric(snapshot.metrics, "brierScore");
                return (
                  <li key={snapshot.id}>
                    <button
                      type="button"
                      aria-pressed={selectedSnapshotId === snapshot.id}
                      className={
                        selectedSnapshotId === snapshot.id ? "snapshot-row snapshot-row--active" : "snapshot-row"
                      }
                      onClick={() => setSelectedSnapshotId(snapshot.id)}
                    >
                      <span className="snapshot-row__title">
                        <strong>{formatDateTime(snapshot.createdAt)}</strong>
                        {snapshot.id === inUseId ? <span className="badge badge--good">In use</span> : null}
                      </span>
                      <span className="snapshot-row__meta">
                        {[
                          snapshot.id.length > 12 ? snapshot.id.slice(0, 8) : snapshot.id,
                          `${snapshot.resolvedOutcomeCount} outcomes`,
                          brier === null ? "not scored" : `Brier ${formatDecimal(brier)}`,
                          snapshot.approved ? "approved" : "not approved",
                        ].join(", ")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
        <SectionCard title={selectedSnapshot ? `Snapshot from ${formatDateTime(selectedSnapshot.createdAt)}` : "Snapshot"}>
          {snapshotDetailQuery.isError ? (
            <InlineError message={snapshotDetailQuery.error.message} />
          ) : selectedSnapshot ? (
            <div className="detail-stack">
              {hasScores ? (
                <section className="metric-grid metric-grid--compact" aria-label="Scores on resolved outcomes">
                  <MetricTile label="Brier score" value={formatDecimal(metrics.brierScore as number)} />
                  <MetricTile label="Log loss" value={formatOptionalDecimal(metrics.logLoss)} />
                  <MetricTile label="Calibration error (ECE)" value={formatOptionalDecimal(metrics.expectedCalibrationError)} />
                  <MetricTile
                    label="Scored traces"
                    value={typeof metrics.traceCount === "number" ? String(metrics.traceCount) : "n/a"}
                  />
                </section>
              ) : null}
              {hasScores && typeof metrics.traceCount === "number" && metrics.traceCount < MIN_RELIABLE_TRACES ? (
                <p className="helper-text">
                  Scored on {metrics.traceCount} resolved trace{metrics.traceCount === 1 ? "" : "s"}; treat these scores
                  as noisy until at least {MIN_RELIABLE_TRACES} judgments have resolved.
                </p>
              ) : null}
              {!hasScores ? (
                <p className="helper-text">
                  Not scored yet: this snapshot was trained before any judgment had a resolved outcome.
                </p>
              ) : null}
              <dl className="meta-list">
                <div>
                  <dt>Calibration</dt>
                  <dd>
                    {detail ? describeCalibration(detail.calibrationParams) : "Loading…"}
                  </dd>
                </div>
                <div>
                  <dt>Weight regime</dt>
                  <dd>{humanizeToken(selectedSnapshot.weightRegime)}</dd>
                </div>
                <div>
                  <dt>Resolved outcomes</dt>
                  <dd>{selectedSnapshot.resolvedOutcomeCount}</dd>
                </div>
                <div>
                  <dt>Training window</dt>
                  <dd>{humanizeToken(selectedSnapshot.trainingWindow)}</dd>
                </div>
                {detail && Object.keys(detail.judgeWeights).length > 0 ? (
                  <div>
                    <dt>Judge weights</dt>
                    <dd>
                      {Object.entries(detail.judgeWeights)
                        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
                        .map(([judge, weight]) => `${humanizeToken(judge)} ${Math.round(weight * 100)}%`)
                        .join(", ")}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <div className="detail-actions">
                <button
                  type="button"
                  disabled={approveMutation.isPending || selectedSnapshot.approved}
                  onClick={() => approveMutation.mutate(selectedSnapshot.id)}
                >
                  {approveMutation.isPending ? "Approving…" : selectedSnapshot.approved ? "Approved" : "Approve snapshot"}
                </button>
                {!selectedSnapshot.approved ? (
                  <p className="helper-text">Approving makes judgments use this snapshot.</p>
                ) : null}
              </div>
              {detail ? (
                <details className="disclosure">
                  <summary>Raw parameters</summary>
                  <pre className="json-block">
                    {JSON.stringify(
                      {
                        calibrationParams: detail.calibrationParams,
                        judgeWeights: detail.judgeWeights,
                        baseRateParams: detail.baseRateParams,
                        marketPriorParams: detail.marketPriorParams,
                        onlineLearningParams: detail.onlineLearningParams,
                        metrics: detail.metrics,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : (
            <EmptyState title="Pick a snapshot" body="Select a snapshot from the history list." />
          )}
        </SectionCard>
      </section>
    </div>
  );
}
