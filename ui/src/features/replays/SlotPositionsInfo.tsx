import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../design-system/Icon";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { parseSlot } from "../../shared/replayQuery";
import "./slot-positions-info.css";

/** One position on a map, and the slots that start there. */
interface PositionRow {
  position: MessageKey;
  slots: [number, number];
}

interface MapPositions {
  name: string;
  /** Column headings over the two slots of a row, where the map has sides
   * worth naming; `null` shows the pair without headings. */
  sides: [MessageKey, MessageKey] | null;
  rows: PositionRow[];
}

/**
 * Which start position each lobby slot is on the two maps where the question
 * comes up most, for the slot filter of the replay searches (#791).
 *
 * Every position is held by one slot per side, so each row is a position with
 * its two slots. Seton's Clutch splits north (odd slots) from south (even);
 * Dual Gap's pairs are kept in the order the players name them ("8/7 bottom
 * air"). The map names stay as the vault spells them; only the positions are
 * translated.
 */
const MAPS: MapPositions[] = [
  {
    name: "Seton's Clutch",
    sides: ["replays.slotPositions.north", "replays.slotPositions.south"],
    rows: [
      { position: "replays.slotPositions.mid", slots: [1, 2] },
      { position: "replays.slotPositions.rock", slots: [3, 4] },
      { position: "replays.slotPositions.beach", slots: [5, 6] },
      { position: "replays.slotPositions.air", slots: [7, 8] },
    ],
  },
  {
    name: "Dual Gap Adaptive v14",
    sides: null,
    rows: [
      { position: "replays.slotPositions.topAir", slots: [1, 2] },
      { position: "replays.slotPositions.front", slots: [3, 4] },
      { position: "replays.slotPositions.secondFront", slots: [9, 10] },
      { position: "replays.slotPositions.navy", slots: [5, 6] },
      { position: "replays.slotPositions.eco", slots: [11, 12] },
      { position: "replays.slotPositions.bottomAir", slots: [8, 7] },
    ],
  },
];

const GAP = 8;
const WIDTH = 480;
const MARGIN = 16;

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
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN);
    const left = Math.min(
      Math.max(MARGIN, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - MARGIN,
    );
    setPosition({ top: rect.bottom + GAP, left });
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
            style={{ top: position.top, left: position.left, width: Math.min(WIDTH, window.innerWidth - 2 * MARGIN) }}
          >
            <div className="slot-positions-heading">{t("replays.slotPositions.heading")}</div>
            <div className="slot-positions-maps">
              {MAPS.map((map) => (
                <table key={map.name} className="slot-positions-map">
                  <caption className="slot-positions-map-name">{map.name}</caption>
                  {map.sides && (
                    <thead>
                      <tr>
                        <th scope="col" />
                        <th scope="col">{t(map.sides[0])}</th>
                        <th scope="col">{t(map.sides[1])}</th>
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {map.rows.map((row) => (
                      <tr key={row.position}>
                        <th scope="row">{t(row.position)}</th>
                        {row.slots.map((slot) => (
                          <td key={slot}>
                            <span className="slot-positions-slot">{slot}</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface SlotFieldProps {
  value: number | null;
  onChange: (slot: number | null) => void;
}

/**
 * The slot filter of both replay searches, under "More filters" (#791).
 *
 * A text field with the numeric keyboard rather than `type="number"`: a slot
 * is one or two digits, and the browser's step arrows only took room from
 * them. `parseSlot` turns anything that is not a slot into "any slot".
 */
export function ReplaySlotField({ value, onChange }: SlotFieldProps) {
  const { t } = useTranslation();
  return (
    <label className="vault-field">
      <span className="vault-field-label">
        {t("replays.search.slot")}
        <SlotPositionsInfo />
      </span>
      <input
        className="vault-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        value={value ?? ""}
        placeholder={t("replays.search.anySlot")}
        title={t("replays.search.slotTooltip")}
        onChange={(event) => onChange(parseSlot(event.target.value))}
      />
    </label>
  );
}
