// The Results tab's filters (#646), behind one "Filters" button above the
// table, as the Chat tab's roster keeps its own: a button that says when
// something is set, and a panel that opens under it.
//
// A panel rather than controls in the head: two inline controls took a row
// of their own over a table that is the point of the tab, and the queue
// dropdown was cramped into the width of its trigger.

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../design-system/Icon";
import { OverlayParentContext, useOverlayLayer } from "../../design-system/useOverlayLayer";
import { useTranslation } from "../../i18n/useTranslation";
import { NO_RESULT_FILTERS, type RatedFilter, type ResultFilters } from "./resultFilters";

const RATED: { value: RatedFilter; label: "playerCard.results.filter.ratedAll" | "playerCard.results.filter.ratedOnly" | "playerCard.results.filter.unratedOnly" }[] = [
  { value: "all", label: "playerCard.results.filter.ratedAll" },
  { value: "rated", label: "playerCard.results.filter.ratedOnly" },
  { value: "unrated", label: "playerCard.results.filter.unratedOnly" },
];

interface Props {
  filters: ResultFilters;
  onChange: (filters: ResultFilters) => void;
  /** The queues this player has games in, with how many each. */
  queues: { value: string; label: string; detail: string }[];
}

/** How many filters are set, for the count on the button. */
export function activeResultFilterCount(filters: ResultFilters): number {
  return (filters.rated === "all" ? 0 : 1) + filters.queues.length;
}

export function ResultFiltersMenu({ filters, onChange, queues }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const layer = useOverlayLayer(open, () => {
    setOpen(false);
    buttonRef.current?.focus();
  }, { elementRef: panelRef });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const count = activeResultFilterCount(filters);
  const toggleQueue = (queue: string, on: boolean) =>
    onChange({
      ...filters,
      queues: on ? [...filters.queues, queue] : filters.queues.filter((held) => held !== queue),
    });

  return (
    <div className="player-results-filter-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`player-results-filter-button${count > 0 ? " is-active" : ""}${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="filter" size={14} />
        {t("playerCard.results.filter.button")}
        {count > 0 && <span className="section-tab-count">{count}</span>}
      </button>
      {open && (
        <OverlayParentContext.Provider value={layer}>
          <div
            ref={panelRef}
            className="player-results-filter-panel"
            role="dialog"
            aria-label={t("playerCard.results.filter.button")}
          >
            <div className="player-results-filter-row">
              <span className="player-results-filter-label">{t("playerCard.results.filter.rated")}</span>
              <div className="settings-segmented" role="group" aria-label={t("playerCard.results.filter.rated")}>
                {RATED.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={filters.rated === option.value ? "is-active" : undefined}
                    aria-pressed={filters.rated === option.value}
                    onClick={() => onChange({ ...filters, rated: option.value })}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </div>

            <div className="player-results-filter-row">
              <span className="player-results-filter-label">{t("playerCard.results.queue")}</span>
              {/* None ticked is every queue; ticks add up, so 3v3 and 4v4
                  together is two of them. */}
              <ul className="player-results-filter-queues">
                {queues.map((queue) => (
                  <li key={queue.value}>
                    <label className="option-check">
                      <input
                        type="checkbox"
                        checked={filters.queues.includes(queue.value)}
                        onChange={(event) => toggleQueue(queue.value, event.target.checked)}
                      />
                      <span>{queue.label}</span>
                      <span className="muted">{queue.detail}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            <div className="player-results-filter-footer">
              <button
                type="button"
                className="btn-ghost"
                disabled={count === 0}
                onClick={() => onChange(NO_RESULT_FILTERS)}
              >
                {t("playerCard.results.filter.reset")}
              </button>
            </div>
          </div>
        </OverlayParentContext.Provider>
      )}
    </div>
  );
}
