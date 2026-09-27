// Checkbox-list dropdown: the Java client's `CategoryFilterController`, which
// its replay search uses for the featured-mod and leaderboard filters.
//
// A `<select multiple>` would be the cheap answer, but it's genuinely awkward:
// ctrl-clicking to combine options is undiscoverable, and it eats vertical
// space proportional to the option count. A popover of checkboxes with a
// summary in the trigger is what both reference clients settled on.
//
// Selecting nothing means "any", not "none": the trigger says so, because a
// filter that silently matched zero rows when untouched would be a trap.

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./multi-select.css";
import "./search-panel.css";
import { useTranslation } from "../i18n/useTranslation";

export interface MultiSelectOption {
  /** The value sent to the backend. */
  value: string;
  label: string;
}

interface Props {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Trigger text when nothing is selected. */
  anyLabel?: string;
  /** Whether options are currently being loaded in the background. */
  loading?: boolean;
  /**
   * A command that belongs to the list rather than to one entry of it, such as
   * managing the entries themselves. It is the first row of the popover, set
   * apart from the checkboxes below, and choosing it closes the popover.
   */
  action?: { label: string; onSelect: () => void };
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  anyLabel,
  loading = false,
  action,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = (value: string) =>
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );

  const summary =
    selected.length === 0
      ? loading && options.length === 0
        ? t("designSystem.multiSelect.loading")
        : anyLabel ?? t("common.any")
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <div className="multi-select" ref={rootRef}>
      <span className="search-panel-label">{label}</span>
      <button
        type="button"
        className={`search-panel-control multi-select-trigger${selected.length > 0 ? " is-active" : ""}`}
        aria-expanded={open}
        aria-label={`${label}: ${summary}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="multi-select-summary">{summary}</span>
        <Icon name="filter" size={13} />
      </button>

      {open && (
        <div className="multi-select-popover" role="group" aria-label={label}>
          {action && (
            <button
              type="button"
              className="multi-select-action"
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          )}
          {loading && options.length === 0 ? (
            <p className="muted multi-select-empty">{t("designSystem.multiSelect.loading")}</p>
          ) : options.length === 0 ? (
            <p className="muted multi-select-empty">{t("designSystem.multiSelect.empty")}</p>
          ) : (
            options.map((option) => (
              <label key={option.value} className="multi-select-option">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={() => toggle(option.value)}
                />
                {option.label}
              </label>
            ))
          )}
          {selected.length > 0 && (
            <button
              type="button"
              className="multi-select-clear"
              onClick={() => onChange([])}
            >
              {t("designSystem.multiSelect.clear")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
