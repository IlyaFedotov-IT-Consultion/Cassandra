import {
  Component,
  type ErrorInfo,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  Link,
} from "react-router-dom";
import {
  humanizeToken,
} from "../format";

export type ToastTone = "success" | "error";

export interface Toast {
  id: string;
  title: string;
  tone: ToastTone;
}

export const toastContext = createContext<{
  pushToast: (title: string, tone?: ToastTone) => void;
} | null>(null);

export type StatusTone = "good" | "bad" | "warn" | "neutral";

export function getStatusTone(value: string): StatusTone {
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

export function WorkspaceToasts({ children }: { children: ReactNode }) {
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

export function useToast() {
  const context = useContext(toastContext);

  if (!context) {
    throw new Error("Toast context is unavailable");
  }

  return context;
}

export function StatusCard({
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

export function PageIntro({
  title,
  description,
  actions,
  returnLink,
}: {
  title: string;
  description?: string;
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
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-intro__actions">{actions}</div> : null}
    </header>
  );
}

export function SectionCard({
  title,
  children,
  kicker,
}: {
  title: string;
  children: ReactNode;
  kicker?: string;
}) {
  const headingId = useId();

  return (
    <section className="section-card" aria-labelledby={headingId}>
      <div className="section-card__header">
        <div>
          <h3 id={headingId}>{title}</h3>
        </div>
      </div>
      {children}
    </section>
  );
}

export function MetricTile({
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

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

export function LoadingState({ label = "Loading workspace data…" }: { label?: string }) {
  return <div className="loading-state">{label}</div>;
}

export function InlineError({ message }: { message: string }) {
  return <div className="inline-error">{message}</div>;
}

export function StatusBanner({
  title,
  body,
  tone,
  children,
}: {
  title: string;
  body: string;
  tone: StatusTone;
  children?: ReactNode;
}) {
  return (
    <section className={`status-banner status-banner--${tone}`} role="status">
      <strong>{title}</strong>
      <p>{body}</p>
      {children}
    </section>
  );
}

export function StatusPill({ value }: { value: string }) {
  return <span className={`status-pill status-pill--${getStatusTone(value)}`}>{humanizeToken(value)}</span>;
}

export function DialogFrame({
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
  const frameRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstField = frameRef.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]), select, textarea, button:not(.dialog-frame__close)",
    );
    firstField?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div ref={frameRef} className="dialog-frame" role="dialog" aria-label={title} aria-modal="true">
        <div className="dialog-frame__header">
          <h3>{title}</h3>
          <button className="ghost-button dialog-frame__close" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Contains a page's render error so the navigation and status stay usable. */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page render failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="status-banner status-banner--bad" role="alert">
        <strong>This page failed to render</strong>
        <p>
          {this.state.error.message}. Reload the page to try again, or pick another page from the navigation.
        </p>
      </div>
    );
  }
}
