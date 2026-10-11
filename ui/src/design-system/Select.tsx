// A single-choice dropdown that looks like the rest of the client, where a
// native `<select>` would open the webview's own list.
//
// Built as the WAI-ARIA "select-only combobox": focus stays on the trigger the
// whole time, and the highlighted option is announced through
// `aria-activedescendant` rather than by moving focus into the list. Every key
// is handled on the trigger itself. An earlier version listened on the window
// while open, so after Tab had moved on, Space, Enter and the arrows typed
// into the next field still drove this list, and its Escape closed the dialog
// around it as well. Now the list closes when focus leaves the control, and
// while it is open it is the top of the overlay stack, so Escape closes the
// list and nothing else.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon";
import { useOverlayLayer } from "./useOverlayLayer";
import "./select.css";

export interface SelectOption<T extends string | number = string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface Props<T extends string | number> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  label?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

/**
 * The option a navigation key moves the highlight to, or `null` for a key the
 * list does not navigate with.
 *
 * Disabled options are stepped over, and the ends do not wrap: holding an
 * arrow key stops at the last option instead of cycling round. With nothing
 * highlighted yet, Down lands on the first enabled option and Up on the last.
 */
export function nextSelectIndex(
  options: readonly { disabled?: boolean }[],
  current: number,
  key: string,
): number | null {
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  if (enabled.length === 0) return null;
  const first = enabled[0];
  const last = enabled[enabled.length - 1];
  switch (key) {
    case "Home":
      return first;
    case "End":
      return last;
    case "ArrowDown":
      if (current < 0) return first;
      return enabled.find((index) => index > current) ?? last;
    case "ArrowUp":
      if (current < 0) return last;
      return [...enabled].reverse().find((index) => index < current) ?? first;
    default:
      return null;
  }
}

/** The DOM id of one option, for `aria-activedescendant`. */
export function selectOptionId(controlId: string, index: number): string {
  return `${controlId}-option-${index}`;
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  label,
  disabled = false,
  className = "",
  placeholder,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const listId = `${id}-listbox`;

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder ?? String(value);

  // A press outside closes the list. Focus leaving it does too (`onBlur`
  // below), but a press on something that cannot take focus moves none.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useOverlayLayer(open, () => {
    setOpen(false);
    triggerRef.current?.focus();
  });

  // Keep the highlighted option in view as the arrows walk a long list.
  useLayoutEffect(() => {
    if (!open || highlightedIndex < 0) return;
    const item = listRef.current?.children[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlightedIndex]);

  // Opening highlights the current value, so the arrows start from it. Done
  // here rather than in an effect keyed on `options`: callers pass a fresh
  // array on every render, and an effect would snap the highlight back to the
  // value each time the parent re-rendered under an open list.
  const openList = () => {
    const selectedIndex = options.findIndex((o) => o.value === value && !o.disabled);
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : (nextSelectIndex(options, -1, "Home") ?? -1));
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (event.key) {
      case "Tab":
        // Focus is moving on; the list goes with it rather than staying open
        // under a control that no longer has the keyboard.
        if (open) setOpen(false);
        return;
      case "Enter":
      case " ":
        // Cancelling the keydown also cancels the click a button would make
        // of it, so these two are handled here and only here.
        event.preventDefault();
        if (open) choose(highlightedIndex);
        else openList();
        return;
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End": {
        if (!open) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openList();
          }
          return;
        }
        event.preventDefault();
        if (event.altKey && event.key === "ArrowUp") {
          choose(highlightedIndex);
          return;
        }
        const next = nextSelectIndex(options, highlightedIndex, event.key);
        if (next !== null) setHighlightedIndex(next);
        return;
      }
    }
  };

  return (
    <div
      className={`select-container ${className}`}
      ref={rootRef}
      onBlur={(event) => {
        if (open && !rootRef.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`select-trigger${open ? " is-open" : ""}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && highlightedIndex >= 0 ? selectOptionId(id, highlightedIndex) : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="select-summary">{displayLabel}</span>
        <Icon name="chevronDown" size={13} className={`select-arrow${open ? " is-open" : ""}`} />
      </button>

      {open && (
        <div className="select-popover" role="listbox" id={listId} ref={listRef} aria-labelledby={id}>
          {options.map((option, idx) => {
            const isSelected = option.value === value;
            const isHighlighted = idx === highlightedIndex;
            return (
              <button
                type="button"
                key={String(option.value)}
                id={selectOptionId(id, idx)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                // Out of the tab order, and a press does not take focus: the
                // trigger keeps it, which is what `aria-activedescendant`
                // relies on and what keeps the list open under the pointer.
                tabIndex={-1}
                disabled={option.disabled}
                className={`select-option${isSelected ? " is-selected" : ""}${isHighlighted ? " is-highlighted" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(idx)}
                onMouseEnter={() => setHighlightedIndex(idx)}
              >
                <span className="select-option-label">{option.label}</span>
                {isSelected && <Icon name="check" size={13} className="select-option-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
