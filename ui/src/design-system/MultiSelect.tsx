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
}

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  anyLabel = "Any",
}: Props) {
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
      ? anyLabel
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
          {options.length === 0 ? (
            <p className="muted multi-select-empty">Nothing to choose from yet.</p>
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
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
