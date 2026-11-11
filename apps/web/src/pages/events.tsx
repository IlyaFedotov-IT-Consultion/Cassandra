import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ChangeEvent,
  type FormEvent,
  useDeferredValue,
  useState,
} from "react";
import {
  Link,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  type EventRecord,
  createEvent,
  fetchEvent,
  listEvents,
  listJudgments,
  listOutcomes,
  recordOutcome,
  runJudgment,
  toIsoStringFromLocalDateTime,
} from "../api";
import {
  ForecastHistoryChart,
  ForecastRange,
} from "../components/charts";
import {
  EventComposerForm,
} from "../components/forms";
import {
  findLatestTrace,
  getLatestExecutionLogEntry,
} from "../components/runtime";
import {
  DialogFrame,
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
  formatProbability,
  humanizeToken,
  shortenIdentifier,
} from "../format";

type JudgmentSummary = Awaited<ReturnType<typeof listJudgments>>[number];

function latestJudgmentFor(eventId: string, judgments: JudgmentSummary[]) {
  return judgments.find((judgment) => judgment.eventId === eventId);
}

function latestTraceFor(eventId: string, judgments: JudgmentSummary[]) {
  return judgments.find((judgment) => judgment.eventId === eventId && judgment.verdictTrace)?.verdictTrace ?? null;
}

export function EventsPage() {
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
      pushToast(error instanceof Error ? error.message : "Unable to create the event", "error");
    },
  });

  if (eventsQuery.isLoading || judgmentsQuery.isLoading) {
    return <LoadingState label="Loading events…" />;
  }

  if (eventsQuery.isError || judgmentsQuery.isError) {
    return (
      <InlineError
        message={
          eventsQuery.error instanceof Error
            ? eventsQuery.error.message
            : judgmentsQuery.error instanceof Error
              ? judgmentsQuery.error.message
              : "Unable to load events"
        }
      />
    );
  }

  const events = eventsQuery.data ?? [];
  const judgments = judgmentsQuery.data ?? [];
  const filteredEvents = events.filter((event) =>
    `${event.question} ${event.entities.join(" ")}`.toLowerCase().includes(deferredSearch.trim().toLowerCase()),
  );
  const notJudged = events.filter((event) => !latestJudgmentFor(event.id, judgments)).length;
  const needAttention = events.filter((event) => {
    const status = latestJudgmentFor(event.id, judgments)?.status;
    return status === "failed" || status === "insufficient_evidence";
  }).length;

  return (
    <div className="page-stack">
      <PageIntro
        title="Events"
        description="Forecast targets and their latest judged probability."
        actions={
          <button type="button" onClick={() => setIsCreateOpen(true)}>
            Create event
          </button>
        }
      />
      <section className="metric-grid">
        <MetricTile label="Tracked events" value={String(events.length)} />
        <MetricTile label="Not judged yet" value={String(notJudged)} />
        <MetricTile label="Need attention" value={String(needAttention)} detail="Last run failed or lacked evidence" />
      </section>
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
          title={events.length === 0 ? "No events yet" : "No events match this filter"}
          body={events.length === 0 ? "Create an event to start forecasting it." : "Clear or change the filter to see more events."}
        />
      ) : (
        <div className="event-grid">
          {filteredEvents.map((event) => {
            const latestJudgment = latestJudgmentFor(event.id, judgments);
            const trace = latestTraceFor(event.id, judgments);

            return (
              <article key={event.id} className="event-card">
                <h3>
                  <Link to={`/events/${event.id}`}>{event.question}</Link>
                </h3>
                {trace ? (
                  <div className="event-card__forecast">
                    <strong>{formatProbability(trace.finalProbability)}</strong>
                    <span>
                      range {formatProbability(trace.confidenceLow)}–{formatProbability(trace.confidenceHigh)}
                    </span>
                  </div>
                ) : (
                  <p className="event-card__pending">Not judged yet</p>
                )}
                <p className="event-card__meta">
                  <span>Due {formatDateTime(event.deadline)}</span>
                  {latestJudgment ? (
                    <span>
                      Last run {formatDateTime(latestJudgment.updatedAt)} <StatusPill value={latestJudgment.status} />
                    </span>
                  ) : null}
                </p>
                <div className="event-card__actions">
                  <Link to={`/events/${event.id}`}>Open event</Link>
                  {latestJudgment ? <Link to={`/judgments/${latestJudgment.id}`}>Latest trace</Link> : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <DialogFrame title="Create event" open={isCreateOpen} onClose={() => setIsCreateOpen(false)}>
        <EventComposerForm
          errorMessage={
            createEventMutation.isError
              ? createEventMutation.error instanceof Error
                ? createEventMutation.error.message
                : "Unable to create the event"
              : null
          }
          submitLabel={createEventMutation.isPending ? "Creating…" : "Create event"}
          onSubmit={(payload) => createEventMutation.mutate(payload)}
        />
      </DialogFrame>
    </div>
  );
}

function toLocalDateTimeInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function RecordOutcomeForm({
  errorMessage,
  submitting,
  onSubmit,
}: {
  errorMessage: string | null;
  submitting: boolean;
  onSubmit: (payload: { resolvedValue: boolean; resolvedAt: string; resolutionSourceUrl: string }) => void;
}) {
  return (
    <form
      className="form-grid"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        onSubmit({
          resolvedValue: form.get("resolvedValue") === "yes",
          resolvedAt: toIsoStringFromLocalDateTime(String(form.get("resolvedAt") ?? "")),
          resolutionSourceUrl: String(form.get("resolutionSourceUrl") ?? ""),
        });
      }}
    >
      {errorMessage ? <InlineError message={errorMessage} /> : null}
      <fieldset className="form-grid__full choice-group">
        <legend>How did it resolve?</legend>
        <label className="choice">
          <input type="radio" name="resolvedValue" value="yes" required />
          <span>Yes</span>
        </label>
        <label className="choice">
          <input type="radio" name="resolvedValue" value="no" />
          <span>No</span>
        </label>
      </fieldset>
      <label>
        <span>Resolved at</span>
        <input type="datetime-local" name="resolvedAt" required defaultValue={toLocalDateTimeInput(new Date())} />
      </label>
      <label>
        <span>Resolution source URL</span>
        <input type="url" name="resolutionSourceUrl" required placeholder="https://" />
      </label>
      <p className="helper-text form-grid__full">
        Outcomes train calibration. Only judgments made before this time count.
      </p>
      <button type="submit" disabled={submitting}>
        {submitting ? "Recording…" : "Record outcome"}
      </button>
    </form>
  );
}

export function EventDetailPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { eventId } = useParams();
  const { pushToast } = useToast();
  const [isOutcomeOpen, setIsOutcomeOpen] = useState(false);
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
  // Outcomes are secondary: a failure here must not hide the forecast, so it never blocks the page.
  const outcomesQuery = useQuery({
    queryKey: ["outcomes", eventId],
    queryFn: () => listOutcomes(eventId ?? ""),
    enabled: Boolean(eventId),
  });
  const runJudgmentMutation = useMutation({
    mutationFn: () => runJudgment(eventId ?? ""),
    onSuccess(judgment) {
      pushToast("Judgment queued.");
      navigate(`/judgments/${judgment.id}`);
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to queue the judgment", "error");
    },
  });
  const outcomeMutation = useMutation({
    mutationFn: (payload: { resolvedValue: boolean; resolvedAt: string; resolutionSourceUrl: string }) =>
      recordOutcome({ eventId: eventId ?? "", ...payload }),
    onSuccess(outcome) {
      pushToast(`Outcome recorded: resolved ${outcome.resolvedValue ? "Yes" : "No"}.`);
      setIsOutcomeOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["outcomes", eventId] });
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to record the outcome", "error");
    },
  });

  if (!eventId) {
    return <InlineError message="Missing event id" />;
  }

  if (eventQuery.isLoading || judgmentsQuery.isLoading) {
    return <LoadingState label="Loading event…" />;
  }

  if (eventQuery.isError || judgmentsQuery.isError) {
    return (
      <InlineError
        message={
          eventQuery.error instanceof Error
            ? eventQuery.error.message
            : judgmentsQuery.error instanceof Error
              ? judgmentsQuery.error.message
              : "Unable to load the event"
        }
      />
    );
  }

  const event = eventQuery.data as EventRecord;
  const judgments = judgmentsQuery.data ?? [];
  const currentOutcome = outcomesQuery.data?.[0] ?? null;
  const latestTrace = findLatestTrace(judgments);
  const history = judgments
    .filter((judgment) => judgment.verdictTrace && judgment.status === "completed")
    .map((judgment) => ({
      id: judgment.id,
      time: judgment.verdictTrace!.evaluationTime,
      probability: judgment.verdictTrace!.finalProbability,
      low: judgment.verdictTrace!.confidenceLow,
      high: judgment.verdictTrace!.confidenceHigh,
    }));

  return (
    <div className="page-stack">
      <PageIntro
        title={event.question}
        returnLink={{
          to: "/events",
          label: "Back to events",
        }}
        actions={
          <>
            <button className="ghost-button" type="button" onClick={() => setIsOutcomeOpen(true)}>
              {currentOutcome ? "Update outcome" : "Record outcome"}
            </button>
            <button type="button" disabled={runJudgmentMutation.isPending} onClick={() => runJudgmentMutation.mutate()}>
              {runJudgmentMutation.isPending ? "Queueing…" : "Run judgment"}
            </button>
          </>
        }
      />
      {latestTrace ? (
        <section className="verdict" aria-label="Latest forecast">
          <div className="verdict__figure">
            <p className="verdict__probability">{formatProbability(latestTrace.finalProbability)}</p>
            <p className="verdict__caption">latest forecast, judged {formatDateTime(latestTrace.evaluationTime)}</p>
          </div>
          <div className="verdict__range">
            <ForecastRange
              probability={latestTrace.finalProbability}
              low={latestTrace.confidenceLow}
              high={latestTrace.confidenceHigh}
              prior={latestTrace.priorProbability}
            />
            <ul className="verdict__facts">
              <li>{`Prior ${formatProbability(latestTrace.priorProbability)}`}</li>
              <li>{`Range ${formatProbability(latestTrace.confidenceLow)}–${formatProbability(latestTrace.confidenceHigh)}`}</li>
            </ul>
          </div>
        </section>
      ) : (
        <EmptyState title="Not judged yet" body="Run a judgment to produce the first forecast for this event." />
      )}
      {history.length > 1 ? (
        <SectionCard title="Forecast history">
          <p className="helper-text">
            Each point is a completed run, with its uncertainty range shaded. Select a point to open that run.
          </p>
          <ForecastHistoryChart
            points={history}
            outcome={currentOutcome}
            onSelect={(judgmentId) => navigate(`/judgments/${judgmentId}`)}
          />
        </SectionCard>
      ) : history.length === 1 ? (
        <p className="helper-text">The forecast history chart appears after the second completed run.</p>
      ) : null}
      <section className="two-up">
        <SectionCard title="Resolution">
          <p>{event.resolutionCriteria}</p>
          <dl className="meta-list">
            <div>
              <dt>Outcome</dt>
              <dd>
                {currentOutcome ? (
                  <>
                    <span>{`Resolved ${currentOutcome.resolvedValue ? "Yes" : "No"} on ${formatDateTime(currentOutcome.resolvedAt)}`}</span>{" "}
                    <a href={currentOutcome.resolutionSourceUrl} target="_blank" rel="noreferrer">
                      Resolution source
                    </a>
                  </>
                ) : outcomesQuery.isError ? (
                  <span className="helper-text">Couldn't load the recorded outcome.</span>
                ) : outcomesQuery.isLoading ? (
                  "Checking…"
                ) : (
                  "Not resolved yet"
                )}
              </dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{formatDateTime(event.deadline)}</dd>
            </div>
            <div>
              <dt>Reference class</dt>
              <dd>{event.referenceClass ? humanizeToken(event.referenceClass) : "None"}</dd>
            </div>
            <div>
              <dt>Entities</dt>
              <dd>{event.entities.join(", ")}</dd>
            </div>
            {event.polymarketMarketId ? (
              <div>
                <dt>Polymarket market</dt>
                <dd title={event.polymarketMarketId}>{shortenIdentifier(event.polymarketMarketId)}</dd>
              </div>
            ) : null}
          </dl>
        </SectionCard>
        <SectionCard title="Runs">
          {judgments.length === 0 ? (
            <EmptyState title="No runs yet" body="Run a judgment to queue the first one." />
          ) : (
            <ul className="run-list" aria-label="Runs">
              {judgments.map((judgment) => {
                const inProgress = judgment.status === "queued" || judgment.status === "running";
                const current = inProgress ? getLatestExecutionLogEntry(judgment) : null;
                return (
                  <li key={judgment.id}>
                    <Link to={`/judgments/${judgment.id}`}>
                      <span>{formatDateTime(judgment.updatedAt)}</span>
                      <strong>{inProgress ? "In progress" : formatProbability(judgment.verdictTrace?.finalProbability)}</strong>
                      <StatusPill value={judgment.status} />
                    </Link>
                    {current ? <p className="run-list__current">{current.message}</p> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </section>
      <DialogFrame title="Record outcome" open={isOutcomeOpen} onClose={() => setIsOutcomeOpen(false)}>
        <RecordOutcomeForm
          errorMessage={
            outcomeMutation.isError
              ? outcomeMutation.error instanceof Error
                ? outcomeMutation.error.message
                : "Unable to record the outcome"
              : null
          }
          submitting={outcomeMutation.isPending}
          onSubmit={(payload) => outcomeMutation.mutate(payload)}
        />
      </DialogFrame>
    </div>
  );
}
