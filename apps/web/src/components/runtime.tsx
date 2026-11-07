import {
  type JudgmentRecordDetails,
  type JudgmentRecordSummary,
} from "../api";
import {
  EmptyState,
  SectionCard,
  StatusPill,
} from "../components/ui";
import {
  formatDateTime,
  humanizeToken,
} from "../format";

export type JudgmentState = JudgmentRecordSummary["status"];

export type ExecutionLogLevel = JudgmentRecordSummary["executionLog"][number]["level"];

export type ExecutionLogStage = JudgmentRecordSummary["executionLog"][number]["stage"];

export function describeJudgmentState(status: JudgmentState) {
  switch (status) {
    case "queued":
      return {
        tone: "neutral" as const,
        title: "Judgment queued",
        body: "This run is waiting for the worker to pick it up. The page will refresh automatically.",
      };
    case "running":
      return {
        tone: "warn" as const,
        title: "Judgment running",
        body: "Evidence collection and judging are in progress. The page will keep polling until the run reaches a terminal state.",
      };
    case "insufficient_evidence":
      return {
        tone: "warn" as const,
        title: "Insufficient evidence",
        body: "The run completed, but the evidence coverage was too weak to support a normal completed verdict.",
      };
    case "failed":
      return {
        tone: "bad" as const,
        title: "Judgment failed",
        body: "This run failed before a complete trace could be persisted. Check the API logs for the underlying error and retry after the issue is fixed.",
      };
    default:
      return null;
  }
}

export function getLatestExecutionLogEntry(
  judgment: Pick<JudgmentRecordSummary, "executionLog">,
) {
  if (judgment.executionLog.length === 0) {
    return null;
  }

  return judgment.executionLog.reduce((latest, entry) =>
    entry.timestamp.localeCompare(latest.timestamp) > 0 ? entry : latest,
  );
}

export function findLatestTrace(judgments: JudgmentRecordSummary[]) {
  return judgments.find((judgment) => judgment.verdictTrace)?.verdictTrace ?? null;
}

/** Why a run failed: the latest error entry's `details.error`, else its message. */
export function findFailureReason(judgment: Pick<JudgmentRecordSummary, "executionLog">) {
  const errors = judgment.executionLog.filter((entry) => entry.level === "error");
  if (errors.length === 0) {
    return null;
  }
  const latest = errors.reduce((current, entry) => (entry.timestamp.localeCompare(current.timestamp) > 0 ? entry : current));
  const detail = (latest.details as Record<string, unknown> | undefined)?.error;
  return {
    stage: latest.stage,
    reason: typeof detail === "string" && detail.trim() ? detail : latest.message,
  };
}

export function RuntimeActivitySummary({
  judgment,
}: {
  judgment: Pick<JudgmentRecordSummary, "status" | "updatedAt" | "executionLog">;
}) {
  const latestEntry = getLatestExecutionLogEntry(judgment);

  return (
    <div className="runtime-activity">
      <p className="runtime-activity__message">
        {latestEntry ? latestEntry.message : "No structured execution events recorded yet."}
      </p>
      <div className="runtime-activity__meta">
        <StatusPill value={judgment.status} />
        {latestEntry ? <StatusPill value={latestEntry.stage} /> : null}
        {latestEntry ? <StatusPill value={latestEntry.level} /> : null}
        <span>{formatDateTime(latestEntry?.timestamp ?? judgment.updatedAt)}</span>
      </div>
    </div>
  );
}

export function ExecutionLogTimeline({
  entries,
}: {
  entries: JudgmentRecordDetails["executionLog"];
}) {
  if (entries.length === 0) {
    return (
      <EmptyState
        title="No execution logs yet"
        body="This judgment has not recorded any structured runtime events yet."
      />
    );
  }

  return (
    <ol className="log-timeline">
      {entries.map((entry, index) => {
        const hasDetails = Object.keys(entry.details).length > 0;

        return (
          <li key={`${entry.timestamp}-${entry.stage}-${index}`} className={`log-entry log-entry--${entry.level}`}>
            <div className="log-entry__meta">
              <StatusPill value={entry.level} />
              <strong>{humanizeToken(entry.stage)}</strong>
              <span>{formatDateTime(entry.timestamp)}</span>
            </div>
            <p className="log-entry__message">{entry.message}</p>
            {hasDetails ? (
              <details className="log-entry__details">
                <summary>Details</summary>
                <pre className="json-block">{JSON.stringify(entry.details, null, 2)}</pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
