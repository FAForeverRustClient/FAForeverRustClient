import type { ReactNode } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import "./status-notice.css";

interface Action {
  label: string;
  onClick: () => void;
}

interface Props {
  /**
   * `busy`: something is on its way and the screen may be stale meanwhile.
   * `error`: something failed; always give it a way out in `action`.
   * `info`: a fact worth a line, neither progress nor failure.
   */
  tone: "busy" | "error" | "info";
  children: ReactNode;
  /** The way out: Retry, Reconnect, Clear filters. */
  action?: Action;
  /** A second, quieter way out, usually Dismiss. */
  secondary?: Action;
  /**
   * The text as the system wrote it, when `children` says it more plainly:
   * shown on hover, so a bug report can still quote the original.
   */
  detail?: string;
  className?: string;
}

/**
 * One line of state above a list or a panel: "Searching…", "Search failed:
 * reason. Retry".
 *
 * The client said these things in four ways (a muted paragraph, a warn-coloured
 * paragraph, a raw reason, or nothing at all), and the failures were the ones
 * most often left unsaid. One primitive, so a failure always reads as one, and
 * always carries its action.
 */
export function StatusNotice({ tone, children, action, secondary, detail, className }: Props) {
  const classes = ["status-notice", `is-${tone}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      <Icon name={tone === "error" ? "alert" : tone === "busy" ? "refresh" : "info"} size={15} />
      <span className="status-notice-text" title={detail}>{children}</span>
      {(action || secondary) && (
        <span className="status-notice-actions">
          {action && <Button onClick={action.onClick}>{action.label}</Button>}
          {secondary && (
            <Button className="status-notice-secondary" onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
