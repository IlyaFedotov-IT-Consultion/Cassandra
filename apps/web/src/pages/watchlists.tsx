import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ChangeEvent,
  useDeferredValue,
  useState,
} from "react";
import {
  Link,
  useParams,
} from "react-router-dom";
import {
  type CandidateEventRecord,
  type WatchlistRecord,
  type WatchlistSchedule,
  createEvent,
  createWatchlist,
  fetchWatchlist,
  fetchWatchlistSchedule,
  listCandidates,
  listWatchlists,
  runWatchlistDiscovery,
} from "../api";
import {
  EventComposerForm,
  WatchlistComposerForm,
  buildEventSeedDefaults,
} from "../components/forms";
import {
  DialogFrame,
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
  formatShortDate,
  humanizeProviderName,
  humanizeToken,
} from "../format";

export function WatchlistsPage() {
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
        helpTopic="watchlists"
        title="Watchlists"
        description="Keyword streams that surface candidate events worth forecasting."
        actions={
          <button type="button" onClick={() => setIsCreateOpen(true)}>
            Create watchlist
          </button>
        }
      />
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
        <EmptyState
          title={(watchlistsQuery.data ?? []).length === 0 ? "No watchlists yet" : "No watchlists match this filter"}
          body={
            (watchlistsQuery.data ?? []).length === 0
              ? "Create a watchlist to start discovering candidate events."
              : "Clear or change the filter to see more watchlists."
          }
        />
      ) : (
        <div className="event-grid">
          {filteredWatchlists.map((watchlist) => (
            <article key={watchlist.id} className="event-card">
              <h3>
                <Link to={`/watchlists/${watchlist.id}`}>{watchlist.name}</Link>
              </h3>
              <p>{watchlist.keywords.join(", ")}</p>
              <p className="event-card__meta">
                <span>{humanizeToken(watchlist.cadence)}</span>
                <span>{watchlist.jurisdictions.join(", ") || "Global"}</span>
                <span>
                  Updated {formatDateTime(watchlist.updatedAt)} <StatusPill value={watchlist.status} />
                </span>
              </p>
              <div className="event-card__actions">
                <Link to={`/watchlists/${watchlist.id}`}>Review candidates</Link>
              </div>
            </article>
          ))}
        </div>
      )}
      <DialogFrame title="Create watchlist" open={isCreateOpen} onClose={() => setIsCreateOpen(false)}>
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

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeSchedule(cadence: string, schedule: WatchlistSchedule | undefined, failed: boolean) {
  if (failed) {
    return "Couldn't load the schedule";
  }
  if (!schedule) {
    return "Checking the schedule…";
  }
  if (schedule.nextRunAt) {
    return `Next run ${formatDateTime(schedule.nextRunAt)}`;
  }
  if (schedule.intervalMs !== null) {
    return "Scheduling is switched off; runs only when started";
  }
  return cadence.trim().toLowerCase() === "manual"
    ? "Runs only when started"
    : `"${cadence}" is not a schedule; runs only when started`;
}

function describeDiscoveryRun(run: NonNullable<WatchlistRecord["lastDiscovery"]>) {
  const failed = run.failedProviders.length;
  return `${humanizeToken(run.trigger)} run, ${plural(run.candidateCount, "candidate")}${
    failed > 0 ? `, ${plural(failed, "source")} failed` : ""
  }`;
}

export function WatchlistDetailPage() {
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
  // The schedule is secondary: if it fails to load the page still works, it just cannot say when the next run is.
  const scheduleQuery = useQuery({
    queryKey: ["watchlist-schedule", watchlistId],
    queryFn: () => fetchWatchlistSchedule(watchlistId ?? ""),
    enabled: Boolean(watchlistId),
  });
  const discoveryMutation = useMutation({
    mutationFn: () => runWatchlistDiscovery(watchlistId ?? ""),
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["candidates", watchlistId] });
      void queryClient.invalidateQueries({ queryKey: ["watchlist", watchlistId] });
      void queryClient.invalidateQueries({ queryKey: ["watchlist-schedule", watchlistId] });
    },
    onError(error) {
      pushToast(error instanceof Error ? error.message : "Unable to run discovery", "error");
    },
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

  const lastRun = discoveryMutation.data;
  const foundCount = lastRun?.candidates.length ?? 0;
  const failures = lastRun?.failedProviders ?? [];
  const schedule = scheduleQuery.data;
  const recorded = watchlist.lastDiscovery;

  return (
    <div className="page-stack">
      <PageIntro
        helpTopic="watchlists"
        title={watchlist.name}
        description={`Watching for ${watchlist.keywords.join(", ")}${
          watchlist.jurisdictions.length > 0 ? ` in ${watchlist.jurisdictions.join(", ")}` : ""
        }.`}
        returnLink={{
          to: "/watchlists",
          label: "Back to watchlists",
        }}
        actions={
          <button type="button" disabled={discoveryMutation.isPending} onClick={() => discoveryMutation.mutate()}>
            {discoveryMutation.isPending ? "Discovering…" : "Run discovery"}
          </button>
        }
      />
      {lastRun ? (
        <StatusBanner
          title={`Discovery found ${foundCount} candidate${foundCount === 1 ? "" : "s"}`}
          body={
            failures.length > 0
              ? `${failures.length} source${failures.length === 1 ? "" : "s"} failed.`
              : "Every source responded."
          }
          tone={failures.length > 0 ? "warn" : "good"}
        >
          {failures.length > 0 ? (
            <details className="status-banner__details" open={failures.length <= 2}>
              <summary>Failed sources</summary>
              <ul>
                {failures.map((failure) => (
                  <li key={failure.providerName}>
                    {`${humanizeProviderName(failure.providerName)} failed: ${failure.error}`}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </StatusBanner>
      ) : null}
      <section className="metric-grid">
        <MetricTile label="Candidates" value={String(candidates.length)} />
        <MetricTile
          label="Schedule"
          value={humanizeToken(watchlist.cadence)}
          detail={describeSchedule(watchlist.cadence, schedule, scheduleQuery.isError)}
        />
        <MetricTile
          label="Last run"
          value={recorded ? formatShortDate(recorded.ranAt) : "Never"}
          detail={recorded ? describeDiscoveryRun(recorded) : "Discovery has not run yet"}
        />
      </section>
      <SectionCard title="Candidates">
        {candidates.length === 0 ? (
          <EmptyState title="No candidates yet" body="Run discovery to look for candidate events in recent evidence." />
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
        title="Seed event from candidate"
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
