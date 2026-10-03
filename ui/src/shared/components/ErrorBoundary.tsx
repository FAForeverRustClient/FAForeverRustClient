// What the client draws when a view throws while rendering.
//
// There was nothing: React unmounts the whole tree on an uncaught render
// error, so one bad value in one tab blanked the window, sidebar, status bar
// and all, with no message and no way back short of restarting the client.
//
// Two boundaries, at two scales. `ViewErrorBoundary` wraps the active tab, so
// the rest of the client keeps working and switching tabs clears it.
// `AppErrorBoundary` wraps everything, for an error in the shell itself, and
// offers the only way out that is left: reloading the window.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { t } from "../../i18n";
import "./error-boundary.css";

interface State {
  error: Error | null;
}

interface ViewProps {
  /** Changing this clears a caught error: the active tab's id. */
  resetKey: string;
  children: ReactNode;
}

function ErrorDetails({ error }: { error: Error }) {
  return (
    <details className="error-boundary-details">
      <summary>{t("shell.viewFailed.details")}</summary>
      <pre>{error.message || String(error)}</pre>
    </details>
  );
}

export class ViewErrorBoundary extends Component<ViewProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("A view failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: ViewProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <EmptyState icon="info" title={t("shell.viewFailed.title")} hint={t("shell.viewFailed.hint")}>
          <Button onClick={() => this.setState({ error: null })}>{t("shell.viewFailed.retry")}</Button>
        </EmptyState>
        <ErrorDetails error={error} />
      </div>
    );
  }
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The client shell failed to render", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary is-app" role="alert">
        <EmptyState icon="info" title={t("app.crashed.title")} hint={t("app.crashed.hint")}>
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t("app.crashed.reload")}
          </Button>
        </EmptyState>
        <ErrorDetails error={error} />
      </div>
    );
  }
}
