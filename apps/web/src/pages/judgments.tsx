import {
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  useEffect,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  fetchEvent,
  fetchJudgment,
  listJudgments,
  runJudgment,
} from "../api";
import {
  buildEnsembleSpread,
  buildEvidenceFlow,
  buildForecastPath,
  EnsembleSpreadChart,
  EvidenceFlowDiagram,
  ForecastPathChart,
  ForecastRange,
} from "../components/charts";
import {
  CitationList,
  JudgeCard,
  PipelineStages,
  readRelevanceScores,
  readSamples,
} from "../components/trace";
import {
  ExecutionLogTimeline,
  RuntimeActivitySummary,
  describeJudgmentState,
  findFailureReason,
} from "../components/runtime";
import {
  EmptyState,
  InlineError,
  LoadingState,
  MetricTile,
  PageIntro,
  SectionCard,
  StatusBanner,
  StatusPill,
  useToast,
} from "../components/ui";
import {
  formatDateTime,
  formatDecimal,
  formatProbability,
  formatSignedDecimal,
  humanizeToken,
} from "../format";

export function isLikelyEnglishCitation(input: { title: string; url: string }) {
  const latinCount = (input.title.match(/[A-Za-z]/g) ?? []).length;
  const cjkCount = (input.title.match(/[\u3400-\u9fff]/g) ?? []).length;

  return latinCount >= Math.max(8, cjkCount * 2) && !/\.cn([/?#:]|$)/i.test(input.url);
}

export function compareCitationsForDisplay(
  left: { title: string; url: string; publishedAt?: string | null },
  right: { title: string; url: string; publishedAt?: string | null },
) {
  const leftPublishedAt = left.publishedAt ? new Date(left.publishedAt).getTime() : Number.NEGATIVE_INFINITY;
  const rightPublishedAt = right.publishedAt ? new Date(right.publishedAt).getTime() : Number.NEGATIVE_INFINITY;
  const publishedGap = rightPublishedAt - leftPublishedAt;

  if (publishedGap !== 0) {
    return publishedGap;
  }

  const englishGap = Number(isLikelyEnglishCitation(right)) - Number(isLikelyEnglishCitation(left));

  if (englishGap !== 0) {
    return englishGap;
  }

  return left.title.localeCompare(right.title) || left.url.localeCompare(right.url);
}

export function JudgmentsPage() {
  const judgmentsQuery = useQuery({
    queryKey: ["judgments"],
    queryFn: () => listJudgments(),
  });

  if (judgmentsQuery.isLoading) {
    return <LoadingState label="Loading recent judgments…" />;
  }

  if (judgmentsQuery.isError) {
    return <InlineError message={judgmentsQuery.error.message} />;
  }

  const judgments = judgmentsQuery.data ?? [];
  const recentActivity = judgments
    .flatMap((judgment) =>
      judgment.executionLog.map((entry) => ({
        judgmentId: judgment.id,
        eventId: judgment.eventId,
        entry,
      })),
    )
    .sort((left, right) => right.entry.timestamp.localeCompare(left.entry.timestamp))
    .slice(0, 8);

  return (
    <div className="page-stack">
      <PageIntro
        title="Judgments"
        description="Scan the run queue, jump into trace detail, and spot stalled or inconclusive forecasts quickly."
      />
      <SectionCard title="Live Activity Feed" kicker="Runtime">
        {recentActivity.length === 0 ? (
          <EmptyState
            title="No runtime activity yet"
            body="Queue a judgment run to start collecting structured execution events."
          />
        ) : (
          <div className="list-stack">
            {recentActivity.map(({ judgmentId, eventId, entry }, index) => (
              <Link key={`${judgmentId}-${entry.timestamp}-${index}`} to={`/judgments/${judgmentId}`} className="list-row">
                <div>
                  <strong>{entry.message}</strong>
                  <p>Judgment {judgmentId}</p>
                  <p>Event {eventId}</p>
                </div>
                <div className="list-row__tail">
                  <StatusPill value={entry.stage} />
                  <StatusPill value={entry.level} />
                  <span>{formatDateTime(entry.timestamp)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>
      <SectionCard title="Recent Runs" kicker="Judgments">
        {judgments.length === 0 ? (
          <EmptyState title="No judgments yet" body="Queue a run from an event detail page to populate this list." />
        ) : (
          <div className="list-stack">
            {judgments.map((judgment) => (
              <Link key={judgment.id} to={`/judgments/${judgment.id}`} className="list-row">
                <div>
                  <strong>{judgment.id}</strong>
                  <p>Event {judgment.eventId}</p>
                  <RuntimeActivitySummary judgment={judgment} />
                </div>
                <div className="list-row__tail">
                  <span>{formatProbability(judgment.verdictTrace?.finalProbability)}</span>
                  <StatusPill value={judgment.status} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

export function JudgmentDetailPage() {
  const { judgmentId } = useParams();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const judgmentQuery = useQuery({
    queryKey: ["judgment", judgmentId],
    queryFn: () => fetchJudgment(judgmentId ?? ""),
    enabled: Boolean(judgmentId),
  });
  const eventId = judgmentQuery.data?.eventId;
  const eventQuery = useQuery({
    queryKey: ["event", eventId],
    queryFn: () => fetchEvent(eventId ?? ""),
    enabled: Boolean(eventId),
  });
  const rerunMutation = useMutation({
    mutationFn: () => runJudgment(eventId ?? ""),
    onSuccess(judgment) {
      pushToast("Judgment queued.");
      navigate(`/judgments/${judgment.id}`);
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to queue the judgment", "error");
    },
  });

  useEffect(() => {
    if (
      judgmentQuery.data &&
      (judgmentQuery.data.status === "queued" || judgmentQuery.data.status === "running")
    ) {
      const handle = window.setTimeout(() => {
        void judgmentQuery.refetch();
      }, 1500);

      return () => window.clearTimeout(handle);
    }

    return undefined;
  }, [judgmentQuery]);

  if (!judgmentId) {
    return <InlineError message="Missing judgment id" />;
  }

  if (judgmentQuery.isLoading) {
    return <LoadingState label="Loading judgment…" />;
  }

  if (judgmentQuery.isError) {
    return <InlineError message={judgmentQuery.error.message} />;
  }

  const judgment = judgmentQuery.data;

  if (!judgment) {
    return <InlineError message="Judgment not found" />;
  }

  const trace = judgment.verdictTrace;
  const statusDetail = describeJudgmentState(judgment.status);
  const inProgress = judgment.status === "queued" || judgment.status === "running";
  const failure = judgment.status === "failed" ? findFailureReason(judgment) : null;
  const spread = trace ? buildEnsembleSpread(trace, judgment.judgeOpinions) : null;
  const conflictsAndGaps = trace ? trace.conflicts.length + trace.missingEvidence.length : 0;

  return (
    <div className="page-stack">
      <PageIntro
        title={eventQuery.data?.question ?? "Judgment"}
        returnLink={{
          to: "/judgments",
          label: "Back to judgments",
        }}
        actions={
          <>
            {eventId ? (
              <Link className="ghost-link" to={`/events/${eventId}`}>
                Open event
              </Link>
            ) : null}
            <button
              type="button"
              disabled={!eventId || inProgress || rerunMutation.isPending}
              onClick={() => rerunMutation.mutate()}
            >
              {rerunMutation.isPending ? "Queueing…" : "Run again"}
            </button>
          </>
        }
      />
      {statusDetail ? <StatusBanner title={statusDetail.title} body={statusDetail.body} tone={statusDetail.tone} /> : null}
      {trace ? (
        <>
          <section className="verdict" aria-label="Verdict">
            <div className="verdict__figure">
              <p className="verdict__probability">{formatProbability(trace.finalProbability)}</p>
              <p className="verdict__caption">
                chance of Yes, judged {formatDateTime(trace.evaluationTime)}
              </p>
            </div>
            <div className="verdict__range">
              <ForecastRange
                probability={trace.finalProbability}
                low={trace.confidenceLow}
                high={trace.confidenceHigh}
                prior={trace.priorProbability}
              />
              <ul className="verdict__facts">
                <li>{`Prior ${formatProbability(trace.priorProbability)}`}</li>
                <li>{`Range ${formatProbability(trace.confidenceLow)}–${formatProbability(trace.confidenceHigh)}`}</li>
                <li>{trace.uncertaintyMethod === "bootstrap" ? "Range from resampling judges" : "Fixed-width range"}</li>
                <li>{humanizeToken(trace.replayFidelity)} replay fidelity</li>
              </ul>
            </div>
          </section>
          <SectionCard title="How the forecast moved">
            <ForecastPathChart steps={buildForecastPath(trace, judgment.judgeOpinions)} />
          </SectionCard>
          {spread && spread.rows.length > 0 ? (
            <SectionCard title="Model agreement">
              <p className="helper-text">
                Each dot is one model's answer for one judge. The tick is the judge's pooled forecast; hollow dots were
                excluded for contradicting their own label. Select a model to follow it across judges.
              </p>
              <EnsembleSpreadChart models={spread.models} rows={spread.rows} finalProbability={trace.finalProbability} />
            </SectionCard>
          ) : null}
          <section className="judge-grid" aria-label="Judges">
            {judgment.judgeOpinions.map((opinion) => (
              <JudgeCard
                key={opinion.id ?? opinion.judgeName}
                opinion={opinion}
                samples={readSamples(trace, opinion.judgeName)}
              />
            ))}
          </section>
          <SectionCard title="Evidence flow">
            <EvidenceFlowDiagram flow={buildEvidenceFlow(trace, judgment.judgeOpinions)} />
          </SectionCard>
          <SectionCard title="Supporting citations">
            <CitationList
              citations={trace.citations}
              relevanceScores={readRelevanceScores(trace)}
              compare={compareCitationsForDisplay}
            />
          </SectionCard>
          <SectionCard title="Pipeline">
            <PipelineStages stages={trace.pipelineStages ?? []} />
          </SectionCard>
          {conflictsAndGaps > 0 ? (
            <SectionCard title="Conflicts and gaps">
              <ul className="note-list">
                {trace.conflicts.map((conflict, index) => (
                  <li key={`conflict-${index}`} className="note-list__item">
                    <p className="note-list__reason">
                      {humanizeToken(conflict.judgeA)} vs {humanizeToken(conflict.judgeB)}{" "}
                      <StatusPill value={`${conflict.severity} severity`} />
                    </p>
                    <p className="note-list__count">{conflict.reason}</p>
                  </li>
                ))}
                {trace.missingEvidence.map((missing, index) => (
                  <li key={`missing-${index}`} className="note-list__item">
                    <p className="note-list__reason">
                      {missing.claim} <StatusPill value={`missing ${missing.sourceFamily}`} />
                    </p>
                    <p className="note-list__count">{missing.reason}</p>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
          <details className="disclosure">
            <summary>Diagnostics</summary>
            <div className="disclosure__body">
              <div className="table-shell">
                <table className="data-table">
                  <caption>Judge weights</caption>
                  <thead>
                    <tr>
                      <th scope="col">Judge</th>
                      <th scope="col">Weight</th>
                      <th scope="col">Dependency discount</th>
                      <th scope="col">Freshness</th>
                      <th scope="col">Log-odds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trace.weightBreakdown.map((item) => (
                      <tr key={item.source}>
                        <td>{humanizeToken(item.source)}</td>
                        <td>{formatDecimal(item.weight)}</td>
                        <td>{formatDecimal(Number(item.details.dependencyDiscount ?? 1))}</td>
                        <td>{formatDecimal(Number(item.details.freshnessDecay ?? 1))}</td>
                        <td>{formatSignedDecimal(Number(item.details.effectiveLogOddsContribution ?? 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className="meta-list">
                <div>
                  <dt>Models</dt>
                  <dd>{trace.modelVersion}</dd>
                </div>
                <div>
                  <dt>Weights and calibration snapshot</dt>
                  <dd>{trace.calibrationVersion}</dd>
                </div>
                <div>
                  <dt>Calibration method</dt>
                  <dd>{humanizeToken(trace.calibrationMethod)}</dd>
                </div>
                <div>
                  <dt>Judge cache</dt>
                  <dd>{trace.cacheEvents.map((event) => humanizeToken(event.status)).join(", ") || "Not used"}</dd>
                </div>
              </dl>
            </div>
          </details>
        </>
      ) : (
        <SectionCard title={judgment.status === "failed" ? "Trace unavailable" : "Trace not available yet"}>
          {failure ? (
            <p className="failure-reason">
              Failed during the {humanizeToken(failure.stage).toLowerCase()} stage: <strong>{failure.reason}</strong>
            </p>
          ) : null}
          <p>{statusDetail?.body ?? "This judgment has not produced a trace yet."}</p>
        </SectionCard>
      )}
      <details className="disclosure" open={!trace}>
        <summary>Execution log ({judgment.executionLog.length} entries)</summary>
        <div className="disclosure__body">
          <ExecutionLogTimeline entries={judgment.executionLog} />
        </div>
      </details>
    </div>
  );
}
