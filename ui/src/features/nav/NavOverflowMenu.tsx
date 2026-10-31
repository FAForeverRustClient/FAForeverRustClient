// The tabs a row of navigation has no room for, behind one button at its end.
//
// The sidebar never needs it: its tabs stack and scroll. A theme that lays the
// navigation out as a bar across the top (the Java client's) runs out of width
// long before it runs out of tabs, and the Java client answers that with a
// dropdown after the last button that fits. This is that dropdown. Which tabs
// are hidden is measured, not configured, so it follows the window, the
// language and the zoom.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Tab } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * The tabs in `group` whose button ends past the group's right edge.
 *
 * Buttons carry their tab in `data-tab`. Measured on every resize of the
 * group and whenever `deps` change (the tab list, the language), since a
 * group clipped to its container keeps its size when its content grows.
 */
export function useOverflowingTabs(group: RefObject<HTMLElement | null>, deps: unknown[]): Tab[] {
  const [hidden, setHidden] = useState<Tab[]>([]);

  useLayoutEffect(() => {
    const element = group.current;
    if (!element) return;
    const measure = () => {
      const edge = element.getBoundingClientRect().right + 0.5;
      const next = [...element.querySelectorAll<HTMLElement>("[data-tab]")]
        .filter((button) => button.getBoundingClientRect().right > edge)
        .map((button) => button.dataset.tab as Tab);
      setHidden((current) =>
        current.length === next.length && current.every((tab, index) => tab === next[index]) ? current : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return hidden;
}

interface NavOverflowMenuProps {
  tabs: Tab[];
  active: Tab;
  /** Whether a hidden tab carries a badge, so the button can say so. */
  badged: boolean;
  onSelect: (tab: Tab) => void;
}

/**
 * A menu that hangs from a button in the navigation: focus moves to its first
 * item on opening, and a click outside or Escape closes it.
 */
export function useNavMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return { open, setOpen, root, toggle };
}

export function NavOverflowMenu({ tabs, active, badged, onSelect }: NavOverflowMenuProps) {
  const { t } = useTranslation();
  const { open, setOpen, root, toggle } = useNavMenu();

  return (
    <div className="nav-overflow" ref={root}>
      <button
        ref={toggle}
        type="button"
        className={`tab nav-overflow-toggle${tabs.includes(active) ? " tab-active" : ""}${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("nav.more")}
        title={t("nav.more")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="nav-overflow-arrow" aria-hidden="true" />
        {badged && <span className="tab-badge is-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="nav-overflow-menu" role="menu" aria-label={t("nav.more")}>
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="menuitem"
              className={tab === active ? "nav-overflow-item is-active" : "nav-overflow-item"}
              aria-current={tab === active ? "page" : undefined}
              onClick={() => {
                setOpen(false);
                onSelect(tab);
              }}
            >
              {t(`nav.tab.${tab}.label`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
