import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../design-system/Icon";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import "./slot-positions-info.css";

/**
 * Which start position each lobby slot is on the two maps where the question
 * comes up most, for the slot filter of the replay searches (#791).
 *
 * The map names stay as the vault spells them; only the positions are
 * translated. Slots that share a role on Dual Gap (one per side) share a row,
 * in the order the players name them.
 */
const MAPS: { name: string; rows: { slots: string; position: MessageKey }[] }[] = [
  {
    name: "Seton's Clutch",
    rows: [
      { slots: "1", position: "replays.slotPositions.northMid" },
      { slots: "2", position: "replays.slotPositions.southMid" },
      { slots: "3", position: "replays.slotPositions.northRock" },
      { slots: "4", position: "replays.slotPositions.southRock" },
      { slots: "5", position: "replays.slotPositions.northBeach" },
      { slots: "6", position: "replays.slotPositions.southBeach" },
      { slots: "7", position: "replays.slotPositions.northAir" },
      { slots: "8", position: "replays.slotPositions.southAir" },
    ],
  },
  {
    name: "Dual Gap Adaptive v14",
    rows: [
      { slots: "1 / 2", position: "replays.slotPositions.topAir" },
      { slots: "3 / 4", position: "replays.slotPositions.front" },
      { slots: "9 / 10", position: "replays.slotPositions.secondFront" },
      { slots: "5 / 6", position: "replays.slotPositions.navy" },
      { slots: "11 / 12", position: "replays.slotPositions.eco" },
      { slots: "8 / 7", position: "replays.slotPositions.bottomAir" },
    ],
  },
];

const GAP = 6;
const WIDTH = 360;

/**
 * A small info icon beside the slot field's label. Hovering or focusing it
 * shows the slot positions in a panel drawn over the page, so the search
 * panel around it cannot clip it.
 */
export function SlotPositionsInfo() {
  const { t } = useTranslation();
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const tooltipId = useId();

  const show = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 16;
    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - WIDTH / 2),
      window.innerWidth - WIDTH - margin,
    );
    setPosition({ top: rect.bottom + GAP, left: Math.max(margin, left) });
  };
  const hide = () => setPosition(null);

  return (
    <>
      <span
        ref={anchor}
        className="slot-positions-info"
        role="img"
        tabIndex={0}
        aria-label={t("replays.slotPositions.heading")}
        aria-describedby={position ? tooltipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        // Inside the field's label: a click would otherwise move focus into
        // the slot input and close the panel it just opened.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => event.preventDefault()}
      >
        <Icon name="info" size={13} />
      </span>
      {position &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className="slot-positions-tooltip"
            style={{ top: position.top, left: position.left, width: WIDTH }}
          >
            <div className="slot-positions-heading">{t("replays.slotPositions.heading")}</div>
            <div className="slot-positions-maps">
              {MAPS.map((map) => (
                <section key={map.name} className="slot-positions-map">
                  <h4 className="slot-positions-map-name">{map.name}</h4>
                  <dl className="slot-positions-list">
                    {map.rows.map((row) => (
                      <div key={row.slots} className="slot-positions-row">
                        <dt className="slot-positions-slot">{row.slots}</dt>
                        <dd className="slot-positions-position">{t(row.position)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
