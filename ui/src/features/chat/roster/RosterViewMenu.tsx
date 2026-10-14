// The filter button beside the roster's search box and the small overlay it
// opens (#513): one place for which players the list shows and in what order.
//
// An overlay rather than controls in the header, because the header is as
// wide as the roster and the search box needs most of it; the button says
// whether anything is set by itself, so the overlay can stay shut.

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../design-system/Icon";
import { RangeSlider } from "../../../design-system/RangeSlider";
import { OverlayParentContext, useOverlayLayer } from "../../../design-system/useOverlayLayer";
import { useTranslation } from "../../../i18n/useTranslation";
import { leaderboardLabel } from "../../../shared/playerRatings";
import { DEFAULT_ROSTER_VIEW, isRosterViewActive, ROSTER_BOARDS, type RosterView } from "./rosterSort";

/** The scale of the rating slider: where FAF ratings actually are. */
const RATING_MIN = -500;
const RATING_MAX = 3000;

interface Props {
  view: RosterView;
  onChange: (view: RosterView) => void;
}

export function RosterViewMenu({ view, onChange }: Props) {
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

  const active = isRosterViewActive(view);
  const set = (changes: Partial<RosterView>) => onChange({ ...view, ...changes });

  return (
    <div className="chat-roster-view" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`chat-roster-view-button${active ? " is-active" : ""}${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("chat.roster.view.button")}
        title={t("chat.roster.view.button")}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="filter" size={14} />
      </button>
      {open && (
        <OverlayParentContext.Provider value={layer}>
          <div
            ref={panelRef}
            className="chat-roster-view-panel"
            role="dialog"
            aria-label={t("chat.roster.view.button")}
          >
            <div className="chat-roster-view-row">
              <span className="chat-roster-view-label">{t("chat.roster.view.board")}</span>
              <div className="settings-segmented" role="group" aria-label={t("chat.roster.view.board")}>
                {ROSTER_BOARDS.map((board) => (
                  <button
                    key={board}
                    type="button"
                    className={view.board === board ? "is-active" : undefined}
                    aria-pressed={view.board === board}
                    onClick={() => set({ board })}
                  >
                    {leaderboardLabel(board)}
                  </button>
                ))}
              </div>
            </div>

            <div className="chat-roster-view-row">
              <span className="chat-roster-view-label">{t("chat.roster.view.order")}</span>
              <div className="settings-segmented" role="group" aria-label={t("chat.roster.view.order")}>
                {(["name", "rating"] as const).map((order) => (
                  <button
                    key={order}
                    type="button"
                    className={view.order === order ? "is-active" : undefined}
                    aria-pressed={view.order === order}
                    onClick={() => set({ order })}
                  >
                    {t(order === "name" ? "chat.roster.view.orderName" : "chat.roster.view.orderRating")}
                  </button>
                ))}
              </div>
            </div>

            <RangeSlider
              label={t("chat.roster.view.range", { board: leaderboardLabel(view.board) })}
              min={RATING_MIN}
              max={RATING_MAX}
              step={50}
              low={view.min}
              high={view.max}
              onChange={(min, max) => set({ min, max })}
            />

            <div className="chat-roster-view-footer">
              <button
                type="button"
                className="chat-roster-view-reset"
                disabled={!active}
                onClick={() => onChange({ ...DEFAULT_ROSTER_VIEW, board: view.board })}
              >
                {t("chat.roster.view.reset")}
              </button>
            </div>
          </div>
        </OverlayParentContext.Provider>
      )}
    </div>
  );
}
