import { HelpPage } from "./pages/help";
import {
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  WorkspaceShell,
} from "./components/shell";
import {
  WorkspaceToasts,
} from "./components/ui";
import {
  CalibrationPage,
} from "./pages/calibration";
import {
  EvaluationPage,
  EvaluationRunPage,
} from "./pages/evaluation";
import {
  EventDetailPage,
  EventsPage,
} from "./pages/events";
import {
  JudgmentDetailPage,
  JudgmentsPage,
} from "./pages/judgments";
import {
  RuntimePage,
} from "./pages/runtime";
import {
  WatchlistDetailPage,
  WatchlistsPage,
} from "./pages/watchlists";

export function App() {
  const location = useLocation();

  return (
    <WorkspaceToasts>
      <WorkspaceShell>
        {location.pathname === "/" ? (
          <Navigate replace to="/events" />
        ) : (
          <Routes>
            <Route path="/help" element={<HelpPage />} />
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
