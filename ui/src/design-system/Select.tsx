import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
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
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder ?? String(value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          const opt = options[highlightedIndex];
          if (!opt.disabled) {
            onChange(opt.value);
            setOpen(false);
          }
        }
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, options, highlightedIndex, onChange]);

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setHighlightedIndex(idx >= 0 ? idx : 0);
      if (idx >= 0 && listRef.current) {
        const item = listRef.current.children[idx] as HTMLElement | undefined;
        item?.scrollIntoView({ block: "nearest" });
      }
    }
  }, [open, value, options]);

  return (
    <div className={`select-container ${className}`} ref={rootRef}>
      <button
        type="button"
        id={id}
        className={`select-trigger${open ? " is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="select-summary">{displayLabel}</span>
        <Icon name="chevronDown" size={13} className={`select-arrow${open ? " is-open" : ""}`} />
      </button>

      {open && (
        <div className="select-popover" role="listbox" ref={listRef} aria-labelledby={id}>
          {options.map((option, idx) => {
            const isSelected = option.value === value;
            const isHighlighted = idx === highlightedIndex;
            return (
              <button
                type="button"
                key={String(option.value)}
                role="option"
                aria-selected={isSelected}
                disabled={option.disabled}
                className={`select-option${isSelected ? " is-selected" : ""}${isHighlighted ? " is-highlighted" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
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
