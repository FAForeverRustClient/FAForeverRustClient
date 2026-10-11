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
import { useOverlayLayer } from "./useOverlayLayer";

export interface MultiSelectOption {
  /** The value sent to the backend. */
  value: string;
  label: string;
  /** A quiet fact beside the label, such as how many there are of it. */
  detail?: string;
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
  /**
   * `inline` puts the label beside the trigger rather than above it, for a
   * toolbar row whose other controls are labelled that way.
   */
  layout?: "stacked" | "inline";
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  anyLabel,
  loading = false,
  action,
  layout = "stacked",
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // Escape closes the list and nothing else: while open, the list is the top
  // of the overlay stack, so a dialog it sits in waits for the next press.
  // Focus goes back to the trigger, since a checkbox that had it is about to
  // be unmounted and would otherwise drop the caret onto the page.
  useOverlayLayer(open, () => {
    setOpen(false);
    triggerRef.current?.focus();
  });

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
        : t("designSystem.multiSelect.count", { count: selected.length });

  return (
    <div className={layout === "inline" ? "multi-select is-inline" : "multi-select"} ref={rootRef}>
      <span className="search-panel-label">{label}</span>
      <button
        ref={triggerRef}
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
                <span className="multi-select-option-label">{option.label}</span>
                {option.detail && <span className="multi-select-option-detail">{option.detail}</span>}
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
