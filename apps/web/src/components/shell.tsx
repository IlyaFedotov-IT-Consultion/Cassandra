import {
  useQuery,
} from "@tanstack/react-query";
import {
  type ReactNode,
} from "react";
import {
  NavLink,
  useLocation,
} from "react-router-dom";
import {
  apiBaseUrl,
  fetchHealth,
  fetchReady,
} from "../api";
import {
  InlineError,
  RouteErrorBoundary,
} from "../components/ui";
import {
  humanizeToken,
} from "../format";

export const navItems = [
  { to: "/events", label: "Events" },
  { to: "/watchlists", label: "Watchlists" },
  { to: "/judgments", label: "Judgments" },
  { to: "/runtime", label: "Runtime" },
  { to: "/evaluation", label: "Evaluation" },
  { to: "/calibration", label: "Calibration" },
] as const;

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  return (
    <div className="workspace">
      <aside className="workspace__sidebar">
        <div className="workspace__brand">
          <h1>Cassandra</h1>
          <p className="workspace__lede">Forecast research workspace</p>
        </div>
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
        <ServiceStatus />
      </aside>
      <main className="workspace__main">
        <RouteErrorBoundary key={location.pathname}>{children}</RouteErrorBoundary>
      </main>
    </div>
  );
}

/** One compact line: API reachability, readiness, and adapter mode. */
export function ServiceStatus() {
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

  const apiState = healthQuery.isError
    ? { tone: "bad" as const, label: "API unreachable" }
    : readyQuery.isError || readyQuery.data?.status === "not_ready"
      ? { tone: "warn" as const, label: "API not ready" }
      : readyQuery.data?.status === "ready"
        ? { tone: "good" as const, label: "API ready" }
        : { tone: "neutral" as const, label: "Checking API" };
  const mode = healthQuery.data?.adapterMode;
  const errorMessage =
    healthQuery.error instanceof Error
      ? healthQuery.error.message
      : readyQuery.error instanceof Error
        ? readyQuery.error.message
        : null;

  return (
    <div className="service-status" role="status" aria-label="Service status">
      <span className={`service-status__dot service-status__dot--${apiState.tone}`} aria-hidden="true" />
      <span>{apiState.label}</span>
      {mode ? <span className="service-status__mode">{humanizeToken(mode)} mode</span> : null}
      <span className="service-status__base" title="API base URL">
        {apiBaseUrl}
      </span>
      {errorMessage ? <InlineError message={errorMessage} /> : null}
    </div>
  );
}
