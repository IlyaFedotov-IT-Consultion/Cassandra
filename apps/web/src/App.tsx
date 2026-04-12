import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Link,
  MemoryRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";

import {
  apiBaseUrl,
  createEvaluationRun,
  createEvent,
  createWatchlist,
  fetchCalibrationSnapshot,
  fetchEvent,
  fetchEvaluationRun,
  fetchHealth,
  fetchJudgment,
  fetchReady,
  fetchWatchlist,
  importPolymarketBenchmarks,
  listBenchmarkMarkets,
  listBenchmarkSets,
  listCalibrationSnapshots,
  listCandidates,
  listEvaluationPredictions,
  listEvaluationRuns,
  listEvents,
  listJudgments,
  listRuntimeEvents,
  listWatchlists,
  retrainCalibrationSnapshot,
  runJudgment,
  splitCommaSeparated,
  toIsoStringFromLocalDateTime,
  type CandidateEventRecord,
  type EvaluationRun,
  type EventRecord,
  type JudgmentRecordDetails,
  type JudgmentRecordSummary,
} from "./api";
import { formatDateTime, humanizeToken } from "./format";

type ToastTone = "success" | "error";

interface Toast {
  id: string;
  title: string;
  tone: ToastTone;
}

const toastContext = createContext<{
  pushToast: (title: string, tone?: ToastTone) => void;
} | null>(null);

const navItems = [
  { to: "/events", label: "Events" },
  { to: "/watchlists", label: "Watchlists" },
  { to: "/judgments", label: "Judgments" },
  { to: "/runtime", label: "Runtime" },
  { to: "/evaluation", label: "Evaluation" },
  { to: "/calibration", label: "Calibration" },
] as const;

const referenceClassValues = [
  "regulatory_approval",
  "election",
  "product_launch",
  "court_decision",
  "macro_release",
  "policy_decision",
  "geopolitical_event",
] as const;

type EventReferenceClass = (typeof referenceClassValues)[number];
type JudgmentState = JudgmentRecordSummary["status"];
type StatusTone = "good" | "bad" | "warn" | "neutral";
type ExecutionLogLevel = JudgmentRecordSummary["executionLog"][number]["level"];
type ExecutionLogStage = JudgmentRecordSummary["executionLog"][number]["stage"];

const executionLogLevelValues = ["all", "info", "warn", "error"] as const;
const executionLogStageValues = [
  "all",
  "queue",
  "run",
  "evidence",
  "coverage",
  "calibration",
  "judge",
  "storage",
] as const;
const judgmentStatusFilterValues = [
  "all",
  "queued",
  "running",
  "completed",
  "insufficient_evidence",
  "failed",
] as const;

function formatProbability(value?: number | null) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "Pending";
}

function formatDecimal(value: number) {
  return value.toFixed(2);
}

function getStatusTone(value: string): StatusTone {
  switch (value) {
    case "ok":
    case "ready":
    case "completed":
    case "active":
    case "approved":
    case "promoted":
    case "hit":
    case "yes":
      return "good";
    case "failed":
    case "not_ready":
    case "error":
      return "bad";
    case "queued":
    case "running":
    case "pending":
    case "insufficient_evidence":
    case "miss":
    case "bypass":
      return "warn";
    default:
      return "neutral";
  }
}

function describeJudgmentState(status: JudgmentState) {
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

function getLatestExecutionLogEntry(
  judgment: Pick<JudgmentRecordSummary, "executionLog">,
) {
  if (judgment.executionLog.length === 0) {
    return null;
  }

  return judgment.executionLog.reduce((latest, entry) =>
    entry.timestamp.localeCompare(latest.timestamp) > 0 ? entry : latest,
  );
}

function buildEventSeedDefaults(candidate: CandidateEventRecord) {
  return {
    question: candidate.title,
    resolutionCriteria: candidate.description,
    deadline: "",
    entities: "",
    referenceClass: "",
    marketSymbols: "",
    polymarketMarketId: "",
  };
}

function summarizeCalibrationSnapshot(snapshot: Awaited<ReturnType<typeof retrainCalibrationSnapshot>>) {
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

function findLatestTrace(judgments: JudgmentRecordSummary[]) {
  return judgments.find((judgment) => judgment.verdictTrace)?.verdictTrace ?? null;
}

function parseReferenceClass(value: FormDataEntryValue | null): EventReferenceClass | null {
  const nextValue = String(value ?? "");

  if (referenceClassValues.includes(nextValue as EventReferenceClass)) {
    return nextValue as EventReferenceClass;
  }

  return null;
}

function WorkspaceToasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const value = {
    pushToast(title: string, tone: ToastTone = "success") {
      const nextToast = {
        id: crypto.randomUUID(),
        title,
        tone,
      };

      setToasts((current: Toast[]) => [...current, nextToast]);
      window.setTimeout(() => {
        setToasts((current: Toast[]) => current.filter((toast: Toast) => toast.id !== nextToast.id));
      }, 3200);
    },
  };

  return (
    <toastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            {toast.title}
          </div>
        ))}
      </div>
    </toastContext.Provider>
  );
}

function useToast() {
  const context = useContext(toastContext);

  if (!context) {
    throw new Error("Toast context is unavailable");
  }

  return context;
}

function WorkspaceShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  return (
    <div className="workspace">
      <aside className="workspace__sidebar">
        <p className="workspace__eyebrow">Research Operations</p>
        <h1>Cassandra Workspace</h1>
        <p className="workspace__lede">
          An editorial operations desk for running forecast research, reviewing trace quality,
          and checking calibration health across the prototype.
        </p>
        <nav className="workspace__nav" aria-label="Primary">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }: { isActive: boolean }) =>
                isActive || location.pathname.startsWith(`${item.to}/`)
                  ? "workspace__nav-link workspace__nav-link--active"
                  : "workspace__nav-link"
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="workspace__aside-note">
          <span>API base</span>
          <strong>{apiBaseUrl}</strong>
        </div>
      </aside>
      <div className="workspace__main">
        <ServiceStatusStrip />
        {children}
      </div>
    </div>
  );
}

function ServiceStatusStrip() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    retry: false,
  });
  const readyQuery = useQuery({
    queryKey: ["ready"],
    queryFn: fetchReady,
    retry: false,
  });
  const healthErrorMessage =
    healthQuery.error instanceof Error ? healthQuery.error.message : null;
  const readinessErrorMessage =
    readyQuery.error instanceof Error ? readyQuery.error.message : null;

  return (
    <>
      <section className="service-strip">
        <StatusCard
          label="Service Health"
          value={healthQuery.data?.status ?? (healthQuery.isError ? "Unavailable" : "Checking")}
          tone={healthQuery.data?.status === "ok" ? "good" : healthQuery.isError ? "bad" : "neutral"}
        />
        <StatusCard
          label="Readiness"
          value={readyQuery.data?.status ?? (readyQuery.isError ? "Unavailable" : "Checking")}
          tone={readyQuery.data?.status === "ready" ? "good" : readyQuery.isError ? "bad" : "neutral"}
        />
        <StatusCard
          label="Workspace Mode"
          value={healthQuery.data?.adapterMode ? humanizeToken(healthQuery.data.adapterMode) : "Unknown"}
          tone={healthQuery.data?.adapterMode ? getStatusTone(healthQuery.data.adapterMode) : "neutral"}
        />
      </section>
      {healthErrorMessage || readinessErrorMessage ? (
        <InlineError
          message={
            healthErrorMessage && readinessErrorMessage
              ? `Health: ${healthErrorMessage} | Readiness: ${readinessErrorMessage}`
              : healthErrorMessage ?? readinessErrorMessage ?? "Workspace status is unavailable"
          }
        />
      ) : null}
    </>
  );
}

function StatusCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: StatusTone;
}) {
  return (
    <div className={`status-card status-card--${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
    </div>
  );
}

function PageIntro({
  title,
  description,
  actions,
  returnLink,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  returnLink?: {
    to: string;
    label: string;
  };
}) {
  return (
    <header className="page-intro">
      <div>
        {returnLink ? (
          <Link className="page-intro__return-link" to={returnLink.to}>
            {returnLink.label}
          </Link>
        ) : null}
        <p className="page-intro__eyebrow">Operator View</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-intro__actions">{actions}</div> : null}
    </header>
  );
}

function SectionCard({
  title,
  children,
  kicker,
}: {
  title: string;
  children: ReactNode;
  kicker?: string;
}) {
  return (
    <section className="section-card">
      <div className="section-card__header">
        <div>
          {kicker ? <p className="section-card__kicker">{kicker}</p> : null}
          <h3>{title}</h3>
        </div>
      </div>
      {children}
    </section>
  );
}

function MetricTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="metric-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function LoadingState({ label = "Loading workspace data…" }: { label?: string }) {
  return <div className="loading-state">{label}</div>;
}

function InlineError({ message }: { message: string }) {
  return <div className="inline-error">{message}</div>;
}

function StatusBanner({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone: StatusTone;
}) {
  return (
    <section className={`status-banner status-banner--${tone}`} role="status">
      <strong>{title}</strong>
      <p>{body}</p>
    </section>
  );
}

function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill status-pill--${getStatusTone(value)}`}>{humanizeToken(value)}</span>;
}

function RuntimeActivitySummary({
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

function RuntimePage() {
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
        title="Runtime Console"
        description="Inspect the live execution timeline across all judgment runs, with filters for status, stage, severity, and search terms."
      />
      <section className="metric-grid">
        <MetricTile label="Runtime events" value={String(filteredEntries.length)} />
        <MetricTile label="Warnings" value={String(warningCount)} />
        <MetricTile label="Errors" value={String(failureCount)} />
      </section>
      <SectionCard title="Activity Explorer" kicker="Runtime">
        <div className="runtime-filters">
          <input
            aria-label="Search runtime logs"
            className="search-input"
            placeholder="Filter by message, judgment id, event id, or detail text"
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
                  <p>Judgment {item.judgmentId}</p>
                  <p>Event {item.eventId}</p>
                  {item.finalProbability !== null ? <p>Final probability {formatProbability(item.finalProbability)}</p> : null}
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

function ExecutionLogTimeline({
  entries,
}: {
  entries: JudgmentRecordDetails["executionLog"];
}) {
  return (
    <SectionCard title="Execution Logs" kicker="Runtime">
      {entries.length === 0 ? (
        <EmptyState
          title="No execution logs yet"
          body="This judgment has not recorded any structured runtime events yet."
        />
      ) : (
        <div className="log-timeline">
          {entries.map((entry, index) => {
            const hasDetails = Object.keys(entry.details).length > 0;

            return (
              <article key={`${entry.timestamp}-${entry.stage}-${index}`} className={`log-entry log-entry--${entry.level}`}>
                <div className="log-entry__meta">
                  <StatusPill value={entry.level} />
                  <strong>{humanizeToken(entry.stage)}</strong>
                  <span>{formatDateTime(entry.timestamp)}</span>
                </div>
                <p className="log-entry__message">{entry.message}</p>
                {hasDetails ? (
                  <pre className="json-block log-entry__details">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function DialogFrame({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog-frame" role="dialog" aria-label={title} aria-modal="true">
        <div className="dialog-frame__header">
          <div>
            <p className="section-card__kicker">Action</p>
            <h3>{title}</h3>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EventsPage() {
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: listEvents,
  });
  const judgmentsQuery = useQuery({
    queryKey: ["judgments"],
    queryFn: () => listJudgments(),
  });
  const createEventMutation = useMutation({
    mutationFn: createEvent,
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      pushToast("Event created.");
      setIsCreateOpen(false);
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to create event", "error");
    },
  });

  if (eventsQuery.isLoading || judgmentsQuery.isLoading) {
    return <LoadingState label="Loading events workspace…" />;
  }

  if (eventsQuery.isError || judgmentsQuery.isError) {
    return (
      <InlineError
        message={
          eventsQuery.error instanceof Error
            ? eventsQuery.error.message
            : judgmentsQuery.error instanceof Error
              ? judgmentsQuery.error.message
              : "Unable to load event data"
        }
      />
    );
  }

  const filteredEvents = (eventsQuery.data ?? []).filter((event) =>
    `${event.question} ${event.entities.join(" ")}`
      .toLowerCase()
      .includes(deferredSearch.trim().toLowerCase()),
  );
  const judgments = judgmentsQuery.data ?? [];
  const latestTrace = findLatestTrace(judgments);

  return (
    <div className="page-stack">
      <PageIntro
        title="Events Workspace"
        description="Review active forecast targets, inspect latest probabilities, and move directly into judgment runs."
        actions={
          <button type="button" onClick={() => setIsCreateOpen(true)}>
            Create event
          </button>
        }
      />
      <section className="metric-grid">
        <MetricTile label="Tracked events" value={String(eventsQuery.data?.length ?? 0)} />
        <MetricTile
          label="Recent judgments"
          value={String(judgments.length)}
          detail="Reverse chronological queue"
        />
        <MetricTile
          label="Latest probability"
          value={formatProbability(latestTrace?.finalProbability)}
          detail={latestTrace ? "From the newest completed trace" : "No completed trace yet"}
        />
      </section>
      <SectionCard title="Open Forecast Targets" kicker="Events">
        <div className="toolbar">
          <input
            aria-label="Search events"
            className="search-input"
            placeholder="Filter by question or entity"
            value={search}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
          />
        </div>
        {filteredEvents.length === 0 ? (
          <EmptyState
            title="No events match this filter"
            body="Create a new event or broaden the current search."
          />
        ) : (
          <div className="card-grid">
            {filteredEvents.map((event) => {
              const latestJudgment = judgments.find((judgment) => judgment.eventId === event.id);
              const finalProbability = latestJudgment?.verdictTrace?.finalProbability;

              return (
                <article key={event.id} className="record-card">
                  <div className="record-card__meta">
                    <StatusPill value={event.status} />
                    <strong>{formatProbability(finalProbability)}</strong>
                  </div>
                  <h3>{event.question}</h3>
                  <p>{event.resolutionCriteria}</p>
                  {latestJudgment ? <RuntimeActivitySummary judgment={latestJudgment} /> : null}
                  <div className="record-card__details">
                    <span>Deadline {formatDateTime(event.deadline)}</span>
                    <span>{event.entities.join(", ")}</span>
                  </div>
                  <div className="record-card__actions">
                    <Link to={`/events/${event.id}`}>Inspect event</Link>
                    {latestJudgment ? <Link to={`/judgments/${latestJudgment.id}`}>Open trace</Link> : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </SectionCard>
      <DialogFrame title="Create Event" open={isCreateOpen} onClose={() => setIsCreateOpen(false)}>
        <EventComposerForm
          errorMessage={
            createEventMutation.isError
              ? createEventMutation.error instanceof Error
                ? createEventMutation.error.message
                : "Unable to create event"
              : null
          }
          submitLabel={createEventMutation.isPending ? "Creating…" : "Create event"}
          onSubmit={(payload) => createEventMutation.mutate(payload)}
        />
      </DialogFrame>
    </div>
  );
}

function EventDetailPage() {
  const navigate = useNavigate();
  const { eventId } = useParams();
  const { pushToast } = useToast();
  const eventQuery = useQuery({
    queryKey: ["event", eventId],
    queryFn: () => fetchEvent(eventId ?? ""),
    enabled: Boolean(eventId),
  });
  const judgmentsQuery = useQuery({
    queryKey: ["judgments", eventId],
    queryFn: () => listJudgments(eventId),
    enabled: Boolean(eventId),
  });
  const runJudgmentMutation = useMutation({
    mutationFn: () => runJudgment(eventId ?? ""),
    onSuccess(judgment) {
      pushToast("Judgment queued.");
      navigate(`/judgments/${judgment.id}`);
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to run judgment", "error");
    },
  });

  if (!eventId) {
    return <InlineError message="Missing event id" />;
  }

  if (eventQuery.isLoading || judgmentsQuery.isLoading) {
    return <LoadingState label="Loading event detail…" />;
  }

  if (eventQuery.isError || judgmentsQuery.isError) {
    return (
      <InlineError
        message={
          eventQuery.error instanceof Error
            ? eventQuery.error.message
            : judgmentsQuery.error instanceof Error
              ? judgmentsQuery.error.message
              : "Unable to load event detail"
        }
      />
    );
  }

  const event = eventQuery.data as EventRecord;
  const judgments = judgmentsQuery.data ?? [];
  const latestTrace = findLatestTrace(judgments);

  return (
    <div className="page-stack">
      <PageIntro
        title="Event Detail"
        description="Run new judgments, inspect the latest signal, and review prior executions for this target."
        returnLink={{
          to: "/events",
          label: "Back to events",
        }}
        actions={
          <button
            type="button"
            disabled={runJudgmentMutation.isPending}
            onClick={() => runJudgmentMutation.mutate()}
          >
            {runJudgmentMutation.isPending ? "Queueing…" : "Run judgment"}
          </button>
        }
      />
      {runJudgmentMutation.isError ? (
        <InlineError
          message={
            runJudgmentMutation.error instanceof Error
              ? runJudgmentMutation.error.message
              : "Unable to queue judgment"
          }
        />
      ) : null}
      <section className="metric-grid">
        <MetricTile label="Latest probability" value={formatProbability(latestTrace?.finalProbability)} />
        <MetricTile
          label="Confidence band"
          value={
            latestTrace
              ? `${formatProbability(latestTrace.confidenceLow)} to ${formatProbability(latestTrace.confidenceHigh)}`
              : "Pending"
          }
        />
        <MetricTile label="Judgment history" value={String(judgments.length)} />
      </section>
      <SectionCard title={event.question} kicker="Forecast target">
        <p>{event.resolutionCriteria}</p>
        <div className="detail-grid">
          <MetricTile label="Deadline" value={formatDateTime(event.deadline)} />
          <MetricTile
            label="Reference class"
            value={event.referenceClass ? humanizeToken(event.referenceClass) : "None"}
          />
          <MetricTile label="Entities" value={event.entities.join(", ")} />
        </div>
      </SectionCard>
      <SectionCard title="Judgment History" kicker="Runs">
        {judgments.length === 0 ? (
          <EmptyState title="No runs yet" body="Use the run button to queue the first judgment." />
        ) : (
          <div className="list-stack">
            {judgments.map((judgment) => (
              <Link key={judgment.id} to={`/judgments/${judgment.id}`} className="list-row">
                <div>
                  <strong>{judgment.id}</strong>
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

function WatchlistsPage() {
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const watchlistsQuery = useQuery({
    queryKey: ["watchlists"],
    queryFn: listWatchlists,
  });
  const createWatchlistMutation = useMutation({
    mutationFn: createWatchlist,
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["watchlists"] });
      pushToast("Watchlist created.");
      setIsCreateOpen(false);
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to create watchlist", "error");
    },
  });

  if (watchlistsQuery.isLoading) {
    return <LoadingState label="Loading watchlists…" />;
  }

  if (watchlistsQuery.isError) {
    return <InlineError message={watchlistsQuery.error.message} />;
  }

  const filteredWatchlists = (watchlistsQuery.data ?? []).filter((watchlist) =>
    `${watchlist.name} ${watchlist.keywords.join(" ")}`
      .toLowerCase()
      .includes(deferredSearch.trim().toLowerCase()),
  );

  return (
    <div className="page-stack">
      <PageIntro
        title="Watchlists Workspace"
        description="Track discovery streams, inspect candidate clusters, and seed new forecast targets when a candidate is worth promoting."
        actions={
          <button type="button" onClick={() => setIsCreateOpen(true)}>
            Create watchlist
          </button>
        }
      />
      <SectionCard title="Discovery Streams" kicker="Watchlists">
        <div className="toolbar">
          <input
            aria-label="Search watchlists"
            className="search-input"
            placeholder="Filter by name or keyword"
            value={search}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
          />
        </div>
        {filteredWatchlists.length === 0 ? (
          <EmptyState title="No watchlists yet" body="Create a watchlist to start reviewing candidates." />
        ) : (
          <div className="card-grid">
            {filteredWatchlists.map((watchlist) => (
              <article key={watchlist.id} className="record-card">
                <div className="record-card__meta">
                  <StatusPill value={watchlist.status} />
                  <strong>{watchlist.cadence}</strong>
                </div>
                <h3>{watchlist.name}</h3>
                <p>{watchlist.keywords.join(", ")}</p>
                <div className="record-card__details">
                  <span>{watchlist.jurisdictions.join(", ") || "Global"}</span>
                  <span>{formatDateTime(watchlist.updatedAt)}</span>
                </div>
                <div className="record-card__actions">
                  <Link to={`/watchlists/${watchlist.id}`}>Review candidates</Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
      <DialogFrame title="Create Watchlist" open={isCreateOpen} onClose={() => setIsCreateOpen(false)}>
        <WatchlistComposerForm
          errorMessage={
            createWatchlistMutation.isError
              ? createWatchlistMutation.error instanceof Error
                ? createWatchlistMutation.error.message
                : "Unable to create watchlist"
              : null
          }
          submitLabel={createWatchlistMutation.isPending ? "Creating…" : "Create watchlist"}
          onSubmit={(payload) => createWatchlistMutation.mutate(payload)}
        />
      </DialogFrame>
    </div>
  );
}

function WatchlistDetailPage() {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { watchlistId } = useParams();
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateEventRecord | null>(null);
  const watchlistQuery = useQuery({
    queryKey: ["watchlist", watchlistId],
    queryFn: () => fetchWatchlist(watchlistId ?? ""),
    enabled: Boolean(watchlistId),
  });
  const candidatesQuery = useQuery({
    queryKey: ["candidates", watchlistId],
    queryFn: () => listCandidates(watchlistId ?? ""),
    enabled: Boolean(watchlistId),
  });
  const createEventMutation = useMutation({
    mutationFn: createEvent,
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      pushToast("Seeded event draft created.");
      setSelectedCandidate(null);
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to create seeded event", "error");
    },
  });

  if (!watchlistId) {
    return <InlineError message="Missing watchlist id" />;
  }

  if (watchlistQuery.isLoading || candidatesQuery.isLoading) {
    return <LoadingState label="Loading watchlist detail…" />;
  }

  if (watchlistQuery.isError || candidatesQuery.isError) {
    return (
      <InlineError
        message={
          watchlistQuery.error instanceof Error
            ? watchlistQuery.error.message
            : candidatesQuery.error instanceof Error
              ? candidatesQuery.error.message
              : "Unable to load watchlist detail"
        }
      />
    );
  }

  const watchlist = watchlistQuery.data;
  const candidates = candidatesQuery.data ?? [];

  if (!watchlist) {
    return <InlineError message="Watchlist not found" />;
  }

  return (
    <div className="page-stack">
      <PageIntro
        title="Watchlist Detail"
        description="Review candidate clusters, assess supporting context, and seed forecast targets from the promising leads."
        returnLink={{
          to: "/watchlists",
          label: "Back to watchlists",
        }}
      />
      <section className="metric-grid">
        <MetricTile label="Candidates" value={String(candidates.length)} />
          <MetricTile label="Cadence" value={humanizeToken(watchlist.cadence)} />
        <MetricTile label="Jurisdictions" value={watchlist.jurisdictions.join(", ") || "Global"} />
      </section>
      <SectionCard title={watchlist.name} kicker="Discovery stream">
        <div className="detail-grid">
          <MetricTile label="Keywords" value={watchlist.keywords.join(", ")} />
          <MetricTile label="Updated" value={formatDateTime(watchlist.updatedAt)} />
          <MetricTile label="Status" value={humanizeToken(watchlist.status)} />
        </div>
      </SectionCard>
      <SectionCard title="Candidate Review" kicker="Candidates">
        {candidates.length === 0 ? (
          <EmptyState title="No candidates yet" body="Run discovery workers to populate this stream." />
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Promotion</th>
                  <th>Cluster</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.id}>
                    <td>
                      <strong>{candidate.title}</strong>
                      <p>{candidate.description}</p>
                    </td>
                    <td>
                      <StatusPill value={candidate.promotionStatus} />
                    </td>
                    <td>{candidate.clusterKey}</td>
                    <td>
                      <button type="button" onClick={() => setSelectedCandidate(candidate)}>
                        Seed event
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      <DialogFrame
        title="Seed Event From Candidate"
        open={Boolean(selectedCandidate)}
        onClose={() => setSelectedCandidate(null)}
      >
        {selectedCandidate ? (
          <EventComposerForm
            defaults={buildEventSeedDefaults(selectedCandidate)}
            errorMessage={
              createEventMutation.isError
                ? createEventMutation.error instanceof Error
                  ? createEventMutation.error.message
                  : "Unable to create seeded event"
                : null
            }
            submitLabel={createEventMutation.isPending ? "Creating…" : "Create event"}
            onSubmit={(payload) => createEventMutation.mutate(payload)}
          />
        ) : null}
      </DialogFrame>
    </div>
  );
}

function JudgmentsPage() {
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
        title="Judgments Workspace"
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

function JudgmentDetailPage() {
  const { judgmentId } = useParams();
  const judgmentQuery = useQuery({
    queryKey: ["judgment", judgmentId],
    queryFn: () => fetchJudgment(judgmentId ?? ""),
    enabled: Boolean(judgmentId),
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
    return <LoadingState label="Loading judgment trace…" />;
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

  return (
    <div className="page-stack">
      <PageIntro
        title="Judgment Trace"
        description="Review the final forecast, inspect disagreement and missing evidence, and check the exact cited record behind the run."
        returnLink={{
          to: "/judgments",
          label: "Back to judgments",
        }}
      />
      {statusDetail ? (
        <StatusBanner
          title={statusDetail.title}
          body={statusDetail.body}
          tone={statusDetail.tone}
        />
      ) : null}
      <ExecutionLogTimeline entries={judgment.executionLog} />
      <section className="metric-grid">
        <MetricTile label="Final probability" value={formatProbability(trace?.finalProbability)} />
        <MetricTile label="Prior" value={formatProbability(trace?.priorProbability)} />
        <MetricTile
          label="Confidence band"
          value={
            trace
              ? `${formatProbability(trace.confidenceLow)} to ${formatProbability(trace.confidenceHigh)}`
              : "Pending"
          }
        />
      </section>
      <SectionCard title="Trace Summary" kicker="Verdict">
        <div className="detail-grid">
          <MetricTile label="Judgment status" value={humanizeToken(judgment.status)} />
          <MetricTile
            label="Replay fidelity"
            value={trace?.replayFidelity ? humanizeToken(trace.replayFidelity) : "Pending"}
          />
          <MetricTile label="Disagreement shrinkage" value={trace ? formatDecimal(trace.disagreementShrinkage) : "0.00"} />
        </div>
      </SectionCard>
      {trace ? (
        <>
          <SectionCard title="Judge Cards" kicker="Opinions">
            <div className="card-grid">
              {judgment.judgeOpinions.map((opinion) => (
                <article key={opinion.id ?? opinion.judgeName} className="record-card">
                  <div className="record-card__meta">
                    <StatusPill value={opinion.evidenceStrength} />
                    <strong>{formatProbability(opinion.probability)}</strong>
                  </div>
                  <h3>{humanizeToken(opinion.judgeName)}</h3>
                  <p>{opinion.rationale}</p>
                  <div className="record-card__details">
                    <span>Confidence {formatProbability(opinion.confidence)}</span>
                    <span>Weight {formatDecimal(opinion.baseWeight)}</span>
                  </div>
                </article>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="Source Weight Breakdown" kicker="Weights">
            <div className="list-stack">
              {trace.weightBreakdown.map((item) => (
                <div key={item.source} className="list-row">
                  <div>
                    <strong>{humanizeToken(item.source)}</strong>
                    <p>{JSON.stringify(item.details)}</p>
                  </div>
                  <div className="list-row__tail">
                    <span>{formatDecimal(item.weight)}</span>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="Citations Timeline" kicker="Evidence">
            <div className="list-stack">
              {trace.citations.map((citation) => (
                <a
                  key={citation.url}
                  className="list-row"
                  href={citation.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <div>
                    <strong>{citation.title}</strong>
                    <p>{humanizeToken(citation.sourceFamily)}</p>
                  </div>
                  <div className="list-row__tail">
                    <span>Open source</span>
                  </div>
                </a>
              ))}
            </div>
          </SectionCard>
          <section className="two-up">
            <SectionCard title="Conflicts" kicker="Disagreement">
              {trace.conflicts.length === 0 ? (
                <EmptyState title="No explicit conflicts" body="The judge panel did not register a material contradiction." />
              ) : (
                <div className="list-stack">
                  {trace.conflicts.map((conflict, index) => (
                    <div key={`${conflict.judgeA}-${conflict.judgeB}-${index}`} className="list-row">
                      <div>
                        <strong>
                          {conflict.judgeA} vs {conflict.judgeB}
                        </strong>
                        <p>{conflict.reason}</p>
                      </div>
                      <div className="list-row__tail">
                        <StatusPill value={conflict.severity} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
            <SectionCard title="Missing Evidence" kicker="Gaps">
              {trace.missingEvidence.length === 0 ? (
                <EmptyState title="No missing-evidence flags" body="The trace did not report an explicit evidence gap." />
              ) : (
                <div className="list-stack">
                  {trace.missingEvidence.map((missing, index) => (
                    <div key={`${missing.claim}-${index}`} className="list-row">
                      <div>
                        <strong>{missing.claim}</strong>
                        <p>{missing.reason}</p>
                      </div>
                      <div className="list-row__tail">
                        <StatusPill value={missing.sourceFamily} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </section>
          <section className="two-up">
            <SectionCard title="Dependency Matrix" kicker="Overlap">
              {trace.dependencyMatrix.length === 0 ? (
                <EmptyState title="No dependency rows" body="The panel did not report overlap between judges." />
              ) : (
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Judge A</th>
                        <th>Judge B</th>
                        <th>Jaccard</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trace.dependencyMatrix.map((entry, index) => (
                        <tr key={`${entry.judgeA}-${entry.judgeB}-${index}`}>
                          <td>{entry.judgeA}</td>
                          <td>{entry.judgeB}</td>
                          <td>{formatDecimal(entry.jaccard)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
            <SectionCard title="Model Metadata" kicker="Versions">
              <div className="detail-grid">
                <MetricTile label="Model" value={trace.modelVersion} />
                <MetricTile label="Weights" value={trace.weightVersion} />
                <MetricTile label="Calibration" value={trace.calibrationVersion} />
              </div>
              <div className="list-stack">
                {trace.cacheEvents.map((event, index) => (
                  <div key={`${event.target}-${index}`} className="list-row">
                    <div>
                      <strong>{event.target}</strong>
                      <p>{event.layer}</p>
                    </div>
                    <div className="list-row__tail">
                      <StatusPill value={event.status} />
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          </section>
        </>
      ) : (
        <SectionCard title="Run State" kicker="Queue">
          <EmptyState
            title={judgment.status === "failed" ? "Trace unavailable" : "Trace not available yet"}
            body={
              statusDetail?.body ??
              "This judgment has not produced a trace yet."
            }
          />
        </SectionCard>
      )}
    </div>
  );
}

function EvaluationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [benchmarkImportDraft, setBenchmarkImportDraft] = useState("");
  const [selectedBenchmarkSetId, setSelectedBenchmarkSetId] = useState("");
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
        title="Evaluation Workspace"
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
          <button
            type="button"
            disabled={!selectedBenchmarkSetId || runMutation.isPending || importMutation.isPending}
            onClick={() => runMutation.mutate(selectedBenchmarkSetId)}
          >
            {runMutation.isPending ? "Launching…" : "Run evaluation"}
          </button>
        </SectionCard>
        <SectionCard title="Recent Evaluation Runs" kicker="History">
          {runs.length === 0 ? (
            <EmptyState title="No evaluation runs yet" body="Launch a run from the selected benchmark set." />
          ) : (
            <div className="list-stack">
              {runs.map((run) => (
                <Link key={run.id} className="list-row" to={`/evaluation/runs/${run.id}`}>
                  <div>
                    <strong>{run.id}</strong>
                    <p>{run.benchmarkSetId}</p>
                  </div>
                  <div className="list-row__tail">
                    <span>{JSON.stringify(run.overallMetrics)}</span>
                  </div>
                </Link>
              ))}
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

function EvaluationRunPage() {
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

  return (
    <div className="page-stack">
      <PageIntro
        title="Evaluation Run"
        description="Compare replay performance, slice metrics, and per-market predictions for the selected benchmark set."
        returnLink={{
          to: "/evaluation",
          label: "Back to evaluation",
        }}
      />
      <section className="metric-grid">
        <MetricTile label="Benchmark set" value={run.benchmarkSetId} />
        <MetricTile label="Replay fidelity" value={humanizeToken(run.replayFidelity)} />
        <MetricTile
          label="Brier score"
          value={typeof run.overallMetrics.brierScore === "number" ? formatDecimal(run.overallMetrics.brierScore) : "n/a"}
        />
      </section>
      <section className="two-up">
        <SectionCard title="Slice Metrics" kicker="Performance">
          {run.sliceResults.length === 0 ? (
            <EmptyState title="No slice metrics" body="This run did not record slice-level metrics." />
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Slice</th>
                    <th>Baseline</th>
                    <th>Brier</th>
                    <th>Log loss</th>
                    <th>Avg abs error</th>
                  </tr>
                </thead>
                <tbody>
                  {run.sliceResults.map((slice) => (
                    <tr key={`${slice.sliceKey}-${slice.baseline}`}>
                      <td>{slice.sliceKey}</td>
                      <td>{slice.baseline}</td>
                      <td>{formatDecimal(slice.brierScore)}</td>
                      <td>{formatDecimal(slice.logLoss)}</td>
                      <td>{formatDecimal(slice.averageAbsoluteError)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
        <SectionCard title="Prediction Table" kicker="Replay rows">
          {predictions.length === 0 ? (
            <EmptyState title="No predictions stored" body="This evaluation run has no persisted prediction rows." />
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Theme</th>
                    <th>Baseline</th>
                    <th>Prediction</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {predictions.map((prediction) => (
                    <tr key={prediction.id}>
                      <td>{prediction.benchmarkMarketId}</td>
                      <td>{prediction.theme ?? "n/a"}</td>
                      <td>{prediction.baseline}</td>
                      <td>{formatDecimal(prediction.predictedProbability)}</td>
                      <td>{String(prediction.outcome)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </section>
    </div>
  );
}

function CalibrationPage() {
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
    return <LoadingState label="Loading calibration workspace…" />;
  }

  if (snapshotsQuery.isError) {
    return <InlineError message={snapshotsQuery.error.message} />;
  }

  const snapshots = snapshotsQuery.data ?? [];

  return (
    <div className="page-stack">
      <PageIntro
        title="Calibration Workspace"
        description="Track snapshot history, inspect calibration parameters, and retrain the active snapshot when new outcomes land."
        actions={
          <button type="button" disabled={retrainMutation.isPending} onClick={() => retrainMutation.mutate()}>
            {retrainMutation.isPending ? "Retraining…" : "Retrain snapshot"}
          </button>
        }
      />
      {retrainMutation.isError ? (
        <InlineError
          message={
            retrainMutation.error instanceof Error
              ? retrainMutation.error.message
              : "Unable to retrain calibration"
          }
        />
      ) : null}
      <section className="two-up">
        <SectionCard title="Snapshot History" kicker="Calibration">
          {snapshots.length === 0 ? (
            <EmptyState title="No snapshots yet" body="Run retraining to create the first calibration snapshot." />
          ) : (
            <div className="list-stack">
              {snapshots.map((snapshot) => (
                <button
                  key={snapshot.id}
                  type="button"
                  className={
                    selectedSnapshotId === snapshot.id ? "list-row list-row--button list-row--active" : "list-row list-row--button"
                  }
                  onClick={() => setSelectedSnapshotId(snapshot.id)}
                >
                  <div>
                    <strong>{snapshot.id}</strong>
                    <p>{snapshot.trainingWindow}</p>
                  </div>
                  <div className="list-row__tail">
                    <span>{snapshot.resolvedOutcomeCount} outcomes</span>
                    <StatusPill value={snapshot.weightRegime} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </SectionCard>
        <SectionCard title="Snapshot Detail" kicker="Selected">
          {snapshotDetailQuery.isLoading ? (
            <LoadingState label="Loading snapshot detail…" />
          ) : snapshotDetailQuery.isError ? (
            <InlineError message={snapshotDetailQuery.error.message} />
          ) : snapshotDetailQuery.data ? (
            <div className="detail-stack">
              <div className="detail-grid">
                <MetricTile label="Training window" value={snapshotDetailQuery.data.trainingWindow} />
                <MetricTile
                  label="Weight regime"
                  value={humanizeToken(snapshotDetailQuery.data.weightRegime)}
                />
                <MetricTile label="Resolved outcomes" value={String(snapshotDetailQuery.data.resolvedOutcomeCount)} />
              </div>
              <pre className="json-block">{JSON.stringify(snapshotDetailQuery.data.calibrationParams, null, 2)}</pre>
            </div>
          ) : (
            <EmptyState title="Pick a snapshot" body="Select a snapshot from the history column." />
          )}
        </SectionCard>
      </section>
    </div>
  );
}

function EventComposerForm({
  defaults,
  errorMessage,
  onSubmit,
  submitLabel,
}: {
  defaults?: {
    question?: string;
    resolutionCriteria?: string;
    deadline?: string;
    entities?: string;
    referenceClass?: string;
    marketSymbols?: string;
    polymarketMarketId?: string;
  };
  errorMessage?: string | null;
  onSubmit: (payload: Parameters<typeof createEvent>[0]) => void;
  submitLabel: string;
}) {
  const formId = useId();

  return (
    <form
      key={formId}
      className="form-grid"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        onSubmit({
          question: String(form.get("question") ?? ""),
          resolutionCriteria: String(form.get("resolutionCriteria") ?? ""),
          deadline: toIsoStringFromLocalDateTime(String(form.get("deadline") ?? "")),
          entities: splitCommaSeparated(String(form.get("entities") ?? "")),
          referenceClass: parseReferenceClass(form.get("referenceClass")),
          marketSymbols: splitCommaSeparated(String(form.get("marketSymbols") ?? "")),
          ...(String(form.get("polymarketMarketId") ?? "")
            ? { polymarketMarketId: String(form.get("polymarketMarketId")) }
            : {}),
        });
      }}
    >
      {errorMessage ? <InlineError message={errorMessage} /> : null}
      <label>
        <span>Question</span>
        <input defaultValue={defaults?.question ?? ""} name="question" required />
      </label>
      <label>
        <span>Deadline</span>
        <input defaultValue={defaults?.deadline ?? ""} name="deadline" required type="datetime-local" />
      </label>
      <label className="form-grid__full">
        <span>Resolution Criteria</span>
        <textarea
          defaultValue={defaults?.resolutionCriteria ?? ""}
          name="resolutionCriteria"
          required
          rows={4}
        />
      </label>
      <label>
        <span>Entities</span>
        <input defaultValue={defaults?.entities ?? ""} name="entities" placeholder="Comma-separated" required />
      </label>
      <label>
        <span>Reference Class</span>
        <select defaultValue={defaults?.referenceClass ?? ""} name="referenceClass">
          <option value="">None</option>
          <option value="regulatory_approval">Regulatory approval</option>
          <option value="election">Election</option>
          <option value="product_launch">Product launch</option>
          <option value="court_decision">Court decision</option>
          <option value="macro_release">Macro release</option>
          <option value="policy_decision">Policy decision</option>
          <option value="geopolitical_event">Geopolitical event</option>
        </select>
      </label>
      <label>
        <span>Market Symbols</span>
        <input defaultValue={defaults?.marketSymbols ?? ""} name="marketSymbols" placeholder="Comma-separated" />
      </label>
      <label>
        <span>Polymarket Market ID</span>
        <input defaultValue={defaults?.polymarketMarketId ?? ""} name="polymarketMarketId" />
      </label>
      <button type="submit">{submitLabel}</button>
    </form>
  );
}

function WatchlistComposerForm({
  errorMessage,
  onSubmit,
  submitLabel,
}: {
  errorMessage?: string | null;
  onSubmit: (payload: Parameters<typeof createWatchlist>[0]) => void;
  submitLabel: string;
}) {
  return (
    <form
      className="form-grid"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);

        onSubmit({
          name: String(form.get("name") ?? ""),
          cadence: String(form.get("cadence") ?? ""),
          keywords: splitCommaSeparated(String(form.get("keywords") ?? "")),
          jurisdictions: splitCommaSeparated(String(form.get("jurisdictions") ?? "")),
          sourceToggles: {
            official: form.get("official") === "on",
            government: form.get("government") === "on",
            community: form.get("community") === "on",
            markets: form.get("markets") === "on",
            predictionMarkets: form.get("predictionMarkets") === "on",
          },
        });
      }}
    >
      {errorMessage ? <InlineError message={errorMessage} /> : null}
      <label>
        <span>Name</span>
        <input name="name" required />
      </label>
      <label>
        <span>Cadence</span>
        <input defaultValue="daily" name="cadence" required />
      </label>
      <label>
        <span>Keywords</span>
        <input name="keywords" placeholder="Comma-separated" required />
      </label>
      <label>
        <span>Jurisdictions</span>
        <input name="jurisdictions" placeholder="Comma-separated" />
      </label>
      <label className="checkbox-row">
        <input defaultChecked name="official" type="checkbox" />
        <span>Official sources</span>
      </label>
      <label className="checkbox-row">
        <input defaultChecked name="government" type="checkbox" />
        <span>Government sources</span>
      </label>
      <label className="checkbox-row">
        <input name="community" type="checkbox" />
        <span>Community sources</span>
      </label>
      <label className="checkbox-row">
        <input name="markets" type="checkbox" />
        <span>Market sources</span>
      </label>
      <label className="checkbox-row">
        <input name="predictionMarkets" type="checkbox" />
        <span>Prediction markets</span>
      </label>
      <button type="submit">{submitLabel}</button>
    </form>
  );
}

export function App() {
  const location = useLocation();

  return (
    <WorkspaceToasts>
      <WorkspaceShell>
        {location.pathname === "/" ? (
          <Navigate replace to="/events" />
        ) : (
          <Routes>
            <Route path="/events" element={<EventsPage />} />
            <Route path="/events/:eventId" element={<EventDetailPage />} />
            <Route path="/watchlists" element={<WatchlistsPage />} />
            <Route path="/watchlists/:watchlistId" element={<WatchlistDetailPage />} />
            <Route path="/judgments" element={<JudgmentsPage />} />
            <Route path="/runtime" element={<RuntimePage />} />
            <Route path="/judgments/:judgmentId" element={<JudgmentDetailPage />} />
            <Route path="/evaluation" element={<EvaluationPage />} />
            <Route path="/evaluation/runs/:runId" element={<EvaluationRunPage />} />
            <Route path="/calibration" element={<CalibrationPage />} />
            <Route path="*" element={<Navigate replace to="/events" />} />
          </Routes>
        )}
      </WorkspaceShell>
    </WorkspaceToasts>
  );
}

export function TestApp({ initialEntries = ["/"] }: { initialEntries?: string[] }) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <App />
    </MemoryRouter>
  );
}
