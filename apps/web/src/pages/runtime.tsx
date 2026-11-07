import {
  useQuery,
} from "@tanstack/react-query";
import {
  type ChangeEvent,
  useDeferredValue,
  useState,
} from "react";
import {
  Link,
} from "react-router-dom";
import {
  listEvents,
  listRuntimeEvents,
} from "../api";
import {
  EmptyState,
  InlineError,
  LoadingState,
  MetricTile,
  PageIntro,
  SectionCard,
  StatusPill,
} from "../components/ui";
import {
  formatDateTime,
  formatProbability,
  humanizeToken,
  shortenIdentifier,
} from "../format";

export const executionLogLevelValues = ["all", "info", "warn", "error"] as const;

export const executionLogStageValues = [
  "all",
  "queue",
  "run",
  "planning",
  "evidence",
  "coverage",
  "calibration",
  "judge",
  "storage",
] as const;

export const judgmentStatusFilterValues = [
  "all",
  "queued",
  "running",
  "completed",
  "insufficient_evidence",
  "failed",
] as const;

export function RuntimePage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof judgmentStatusFilterValues)[number]>("all");
  const [stageFilter, setStageFilter] = useState<(typeof executionLogStageValues)[number]>("all");
  const [levelFilter, setLevelFilter] = useState<(typeof executionLogLevelValues)[number]>("all");
  const deferredSearch = useDeferredValue(search);
  const runtimeQuery = useQuery({
    queryKey: ["runtime-events", deferredSearch, statusFilter, stageFilter, levelFilter],
    queryFn: () =>
      listRuntimeEvents({
        search: deferredSearch.trim() ? deferredSearch : undefined,
        judgmentStatus: statusFilter === "all" ? undefined : statusFilter,
        stage: stageFilter === "all" ? undefined : stageFilter,
        level: levelFilter === "all" ? undefined : levelFilter,
        limit: 200,
      }),
  });

  // Shares the events page cache; rows fall back to a short id until (or unless) it loads.
  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: listEvents,
  });
  const questionsById = new Map((eventsQuery.data ?? []).map((event) => [event.id, event.question]));

  if (runtimeQuery.isLoading) {
    return <LoadingState label="Loading runtime activity…" />;
  }

  if (runtimeQuery.isError) {
    return <InlineError message={runtimeQuery.error.message} />;
  }

  const filteredEntries = runtimeQuery.data ?? [];
  const failureCount = filteredEntries.filter((item) => item.entry.level === "error").length;
  const warningCount = filteredEntries.filter((item) => item.entry.level === "warn").length;

  return (
    <div className="page-stack">
      <PageIntro
        title="Runtime"
        description="Inspect the live execution timeline across all judgment runs, with filters for status, stage, severity, and search terms."
      />
      <section className="metric-grid">
        <MetricTile label="Runtime events" value={String(filteredEntries.length)} />
        <MetricTile label="Warnings" value={String(warningCount)} />
        <MetricTile label="Errors" value={String(failureCount)} />
      </section>
      <SectionCard title="Activity">
        <div className="runtime-filters">
          <input
            aria-label="Search runtime logs"
            className="search-input"
            placeholder="Filter by message or id"
            value={search}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
          />
          <label>
            <span>Status</span>
            <select
              aria-label="Runtime status filter"
              value={statusFilter}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setStatusFilter(event.target.value as (typeof judgmentStatusFilterValues)[number])
              }
            >
              {judgmentStatusFilterValues.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All statuses" : humanizeToken(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Stage</span>
            <select
              aria-label="Runtime stage filter"
              value={stageFilter}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setStageFilter(event.target.value as (typeof executionLogStageValues)[number])
              }
            >
              {executionLogStageValues.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All stages" : humanizeToken(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Severity</span>
            <select
              aria-label="Runtime severity filter"
              value={levelFilter}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setLevelFilter(event.target.value as (typeof executionLogLevelValues)[number])
              }
            >
              {executionLogLevelValues.map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All severities" : humanizeToken(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {filteredEntries.length === 0 ? (
          <EmptyState
            title="No runtime events match these filters"
            body="Broaden the current search or clear one of the filters to see more activity."
          />
        ) : (
          <div className="list-stack">
            {filteredEntries.map((item, index) => (
              <Link
                key={`${item.judgmentId}-${item.entry.timestamp}-${index}`}
                to={`/judgments/${item.judgmentId}`}
                className="list-row list-row--runtime"
              >
                <div>
                  <strong>{item.entry.message}</strong>
                  <p>{questionsById.get(item.eventId) ?? `Event ${shortenIdentifier(item.eventId)}`}</p>
                  <p className="helper-text">
                    {`Run ${shortenIdentifier(item.judgmentId)}`}
                    {item.finalProbability !== null ? ` · forecast ${formatProbability(item.finalProbability)}` : ""}
                  </p>
                </div>
                <div className="list-row__tail">
                  <StatusPill value={item.judgmentStatus} />
                  <StatusPill value={item.entry.stage} />
                  <StatusPill value={item.entry.level} />
                  <span>{formatDateTime(item.entry.timestamp)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
