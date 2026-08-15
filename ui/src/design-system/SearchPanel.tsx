import type { FormEventHandler, ReactNode } from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";
import "./search-panel.css";
import { useTranslation } from "../i18n/useTranslation";

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
  label,
}: {
  disabled?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <Button type="submit" variant="primary" className="search-panel-submit" disabled={disabled}>
      <Icon name="search" size={15} /> {label ?? t("designSystem.searchPanel.search")}
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
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="search-panel-toggle"
      aria-expanded={expanded}
      onClick={onClick}
    >
      <Icon name="filter" size={14} />
      {expanded ? t("designSystem.searchPanel.fewer") : count > 0 ? t("designSystem.searchPanel.moreCount", { count }) : t("designSystem.searchPanel.more")}
    </button>
  );
}
