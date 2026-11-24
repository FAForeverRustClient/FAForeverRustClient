import type { MessageKey } from "../../i18n";

/** One position on a map, and the slots that start there. */
export interface PositionRow {
  position: MessageKey;
  slots: [number, number];
}

export interface MapPositions {
  /** The map's name as the vault spells it: a proper noun, never translated. */
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
 * its two slots, the odd one first. Seton's Clutch puts the odd slots north
 * and the even ones south; Dual Gap Adaptive v14 puts them left and right, as
 * its `_save.lua` places the spawn markers (odd at x 112 to 184, even at x 840
 * to 911), so its bottom air is 7 on the left and 8 on the right. The map
 * names stay as the vault spells them; only the positions and sides are
 * translated, through their catalogue keys.
 *
 * A data file of its own so the i18n scan can pass over the map names (see
 * `IGNORED_FILES` in `scripts/i18n-scan.mjs`) and still read the component.
 */
export const SLOT_POSITION_MAPS: MapPositions[] = [
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
    sides: ["replays.slotPositions.left", "replays.slotPositions.right"],
    rows: [
      { position: "replays.slotPositions.topAir", slots: [1, 2] },
      { position: "replays.slotPositions.front", slots: [3, 4] },
      { position: "replays.slotPositions.secondFront", slots: [9, 10] },
      { position: "replays.slotPositions.navy", slots: [5, 6] },
      { position: "replays.slotPositions.eco", slots: [11, 12] },
      { position: "replays.slotPositions.bottomAir", slots: [7, 8] },
    ],
  },
];
