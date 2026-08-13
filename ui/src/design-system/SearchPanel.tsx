import type { FormEventHandler, ReactNode } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import "./search-panel.css";

interface SearchPanelProps {
  children: ReactNode;
  secondary?: ReactNode;
  advanced?: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  className?: string;
}

/** Shared two-tier search surface used by data-heavy catalogue screens. */
export function SearchPanel({
  children,
  secondary,
  advanced,
  onSubmit,
  className = "",
}: SearchPanelProps) {
  return (
    <form
      className={`search-panel surface-panel ${className}`.trim()}
      onSubmit={onSubmit}
    >
      <div className="search-panel-primary">{children}</div>
      {secondary && <div className="search-panel-secondary">{secondary}</div>}
      {advanced}
    </form>
  );
}

export function SearchField({
  label,
  children,
  className = "",
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`search-panel-field ${className}`.trim()}>
      <span className="search-panel-label">{label}</span>
      {children}
    </label>
  );
}

export function SearchPanelSubmit({
  disabled = false,
  label = "Search",
}: {
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Button type="submit" variant="primary" className="search-panel-submit" disabled={disabled}>
      <Icon name="search" size={15} /> {label}
    </Button>
  );
}

export function SearchPanelToggle({
  expanded,
  count = 0,
  onClick,
}: {
  expanded: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="search-panel-toggle"
      aria-expanded={expanded}
      onClick={onClick}
    >
      <Icon name="filter" size={14} />
      {expanded ? "Fewer filters" : `More filters${count > 0 ? ` (${count})` : ""}`}
    </button>
  );
}
