import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import "./section-tabs.css";

export interface SectionTab<T extends string | number> {
  id: T;
  label: ReactNode;
  count?: number;
}

interface Props<T extends string | number> {
  active: T | null;
  ariaLabel: string;
  className?: string;
  items: readonly SectionTab<T>[];
  onChange: (id: T) => void;
  /**
   * Ties each tab to the panel it shows. With a prefix, every tab gets
   * `id={sectionTabId(prefix, id)}` and `aria-controls` pointing at
   * `sectionPanelId(prefix, id)`; the caller then renders the active panel
   * with `{...sectionPanelProps(prefix, active)}`, which supplies that id,
   * `role="tabpanel"` and the `aria-labelledby` back to its tab. Without one
   * the tabs still get stable ids, but no `aria-controls`, since it would
   * point at an element that does not exist.
   */
  idPrefix?: string;
}

/** The DOM id of one tab. */
export function sectionTabId(prefix: string, id: string | number): string {
  return `${prefix}-tab-${id}`;
}

/** The DOM id of the panel one tab shows. */
export function sectionPanelId(prefix: string, id: string | number): string {
  return `${prefix}-panel-${id}`;
}

/**
 * What the panel under a `SectionTabs` needs to be announced as that tab's
 * panel. Focusable, as the ARIA tabs pattern asks, so a panel with nothing
 * focusable in it can still be reached and read after the tabs.
 */
export function sectionPanelProps(prefix: string, id: string | number) {
  return {
    id: sectionPanelId(prefix, id),
    role: "tabpanel" as const,
    "aria-labelledby": sectionTabId(prefix, id),
    tabIndex: 0,
  };
}

/**
 * The tab a key moves to, or `null` for a key the tab list does not take.
 *
 * Left and Right wrap at the ends, as the ARIA tabs pattern has them: a row
 * of tabs is short and seen whole, so stepping off one end and onto the other
 * is not the surprise it would be in a long list. Home and End go to the ends.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowLeft":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Compact underline navigation for switching peer views inside a feature.
 *
 * One tab stop for the whole row (the active tab, or the first when none is),
 * with the arrows, Home and End moving between tabs and showing each as they
 * land on it: the "automatic activation" form of the ARIA tabs pattern, which
 * suits views that are already loaded and cheap to switch.
 */
export function SectionTabs<T extends string | number>({
  active,
  ariaLabel,
  className = "",
  items,
  onChange,
  idPrefix,
}: Props<T>) {
  const generatedPrefix = useId();
  const prefix = idPrefix ?? generatedPrefix;
  const listRef = useRef<HTMLElement>(null);
  const activeIndex = items.findIndex((item) => item.id === active);
  const tabStop = activeIndex >= 0 ? activeIndex : 0;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = items.findIndex((item) => sectionTabId(prefix, item.id) === (event.target as HTMLElement).id);
    const next = nextTabIndex(event.key, current >= 0 ? current : activeIndex, items.length);
    if (next === null) return;
    event.preventDefault();
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    onChange(items[next].id);
  };

  return (
    <nav
      ref={listRef}
      className={`section-tabs ${className}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={sectionTabId(prefix, item.id)}
          aria-selected={active === item.id}
          aria-controls={idPrefix ? sectionPanelId(prefix, item.id) : undefined}
          tabIndex={index === tabStop ? 0 : -1}
          className={active === item.id ? "active" : undefined}
          onClick={() => onChange(item.id)}
        >
          <span className="section-tab-label">{item.label}</span>
          {item.count !== undefined && <span className="section-tab-count">{item.count}</span>}
        </button>
      ))}
    </nav>
  );
}
