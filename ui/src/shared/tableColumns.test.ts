import { describe, expect, it } from "vitest";
import { MIN_BROWSER_COLUMN_PX } from "./browsingPreferences";
import {
  columnTemplate,
  fitColumns,
  resolveColumnWidths,
  withBoundaryTraded,
} from "./tableColumns";

const WIDTHS = [120, 110, 260, 84, 84, 150, 130, 128];
const FLEXIBLE = 2;
const TOTAL = WIDTHS.reduce((sum, width) => sum + width, 0);
/** A pixel for every column, which is no floor at all. */
const NO_FLOORS = WIDTHS.map(() => MIN_BROWSER_COLUMN_PX);
/** The live table's: a thumbnail, a time, a title, figures, a name, Watch. */
const FLOORS = [60, 56, 120, 48, 48, 64, 56, 108];

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("a table's stored column widths", () => {
  it("falls back to the designed width for anything not stored", () => {
    // Empty, short and over-long are all "use the design for the rest": a
    // release that adds or drops a column must not leave the table unusable.
    expect(resolveColumnWidths([], WIDTHS)).toEqual(WIDTHS);
    expect(resolveColumnWidths(undefined, WIDTHS)).toEqual(WIDTHS);
    expect(resolveColumnWidths([200], WIDTHS)).toEqual([200, ...WIDTHS.slice(1)]);
    expect(resolveColumnWidths([...WIDTHS, 999], WIDTHS)).toEqual(WIDTHS);
  });

  it("keeps a stored width however wide it was dragged", () => {
    // There is no ceiling. A column somebody dragged to nine thousand pixels
    // is nine thousand pixels wide when they come back to it.
    expect(resolveColumnWidths([9999], WIDTHS)[0]).toBe(9999);
    expect(resolveColumnWidths([1], WIDTHS)[0]).toBe(MIN_BROWSER_COLUMN_PX);
  });
});

describe("the template a set of widths draws", () => {
  it("gives the flexible column whatever the others leave", () => {
    expect(columnTemplate([56, 260, 140], 1)).toBe("56px minmax(0, 1fr) 140px");
  });

  it("never squeezes the flexible column under its floor", () => {
    // When every column is at its floor and the row is still too narrow, a
    // bare 1fr would go to nothing while the others spilled past the edge.
    expect(columnTemplate([56, 260, 140], 1, 120)).toBe("56px minmax(120px, 1fr) 140px");
  });
});

describe("fitting a list to its space", () => {
  it("draws the columns as dragged while they fit, the slack going to the flexible column", () => {
    // The drawn widths are what each column is given; the flexible column
    // takes the rest of the row on top of its own.
    const fit = fitColumns(WIDTHS, FLOORS, TOTAL + 300);
    expect(fit.drawn).toEqual(WIDTHS);
    expect(fit.scale).toBe(1);
    expect(fit.overflow).toBe(false);
    // Not measured yet: as dragged.
    expect(fitColumns(WIDTHS, FLOORS, 0).drawn).toEqual(WIDTHS);
  });

  it("takes from the flexible column first", () => {
    // From a wide window down to exactly the stored widths, only the slack
    // shrinks: no other column has narrowed by a pixel.
    for (const space of [TOTAL + 300, TOTAL + 1, TOTAL]) {
      expect(fitColumns(WIDTHS, FLOORS, space).drawn).toEqual(WIDTHS);
    }
    // Any less and the columns start to give, in proportion.
    expect(fitColumns(WIDTHS, FLOORS, TOTAL - 100).scale).toBeLessThan(1);
  });

  it("then narrows every column above its floor in proportion", () => {
    const fit = fitColumns(WIDTHS, NO_FLOORS, TOTAL / 2);
    expect(fit.scale).toBeCloseTo(0.5);
    // Every column is still there, just narrower, by the same share.
    expect(fit.drawn).toEqual(WIDTHS.map((width) => Math.floor(width / 2)));
    expect(fit.total).toBeLessThanOrEqual(TOTAL / 2);
  });

  it("stops a column at its floor and takes the rest from the columns above theirs", () => {
    // 700 pixels for 1066 pixels of columns: the Watch column would be drawn
    // at 84 in proportion, under the 108 its button needs. It stays at 108,
    // and the columns still above their floors give up the difference.
    const fit = fitColumns(WIDTHS, FLOORS, 700);
    expect(fit.drawn[7]).toBe(108);
    expect(fit.drawn.every((width, index) => width >= FLOORS[index])).toBe(true);
    expect(fit.total).toBeLessThanOrEqual(700);
    expect(fit.total).toBeGreaterThan(700 - WIDTHS.length);
    // Those above their floors share one scale.
    const free = WIDTHS.map((_, index) => index).filter((index) => fit.drawn[index] > FLOORS[index]);
    expect(free.length).toBeGreaterThan(1);
    for (const index of free) {
      expect(fit.drawn[index]).toBe(Math.floor(WIDTHS[index] * fit.scale));
    }
  });

  it("keeps the matchmaker's replay buttons whole at 1280 pixels with the party chat open", () => {
    // The recent results table has 478 pixels there. In proportion the replay
    // column came to 71 and its vault button fell outside the card. These are
    // that table's designed widths and floors.
    const defaults = [64, 220, 70, 220, 110, 96, 80, 150];
    const floors = [60, 50, 36, 40, 40, 56, 42, 150];
    const fit = fitColumns(defaults, floors, 478);
    expect(fit.drawn[7]).toBe(150);
    expect(fit.drawn[0]).toBe(60);
    expect(fit.overflow).toBe(false);
    expect(fit.total).toBeLessThanOrEqual(478);
  });

  it("draws a column stored under its floor at its floor", () => {
    // A width saved before the column had a floor, or dragged under it.
    const stored = [...WIDTHS];
    stored[7] = 40;
    expect(fitColumns(stored, FLOORS, TOTAL + 300).drawn[7]).toBe(108);
    expect(fitColumns(stored, FLOORS, 700).drawn[7]).toBe(108);
  });

  it("overflows only once every column is at its floor", () => {
    const floorTotal = sum(FLOORS);
    // A pixel more than the floors: still fitted, nothing overflowing.
    const tight = fitColumns(WIDTHS, FLOORS, floorTotal + 1);
    expect(tight.overflow).toBe(false);
    expect(tight.total).toBeLessThanOrEqual(floorTotal + 1);
    // Fewer pixels than the floors: every column at its floor, and the list
    // is as wide as they are, to be scrolled rather than squeezed or cut.
    const narrow = fitColumns(WIDTHS, FLOORS, floorTotal - 200);
    expect(narrow.drawn).toEqual(FLOORS);
    expect(narrow.total).toBe(floorTotal);
    expect(narrow.overflow).toBe(true);
    // Exactly full counts as well, so a table measured at the width it was
    // given for its floors keeps that width rather than letting go of it.
    expect(fitColumns(WIDTHS, FLOORS, floorTotal).overflow).toBe(true);
  });
});

describe("dragging a divider", () => {
  const floorAt = (floors: readonly number[], scale: number) => (index: number) => floors[index] / scale;

  it("trades width between the two columns it separates", () => {
    const floor = (index: number) => (index === FLEXIBLE ? 80 : MIN_BROWSER_COLUMN_PX);
    // The line in front of column 3 moves both of its neighbours.
    expect(withBoundaryTraded(WIDTHS, 3, -50, floor).slice(2, 4)).toEqual([210, 134]);
    // And the flexible column stops at its floor.
    expect(withBoundaryTraded(WIDTHS, 3, -5000, floor)[2]).toBe(80);
    expect(withBoundaryTraded(WIDTHS, 3, -5000, floor)[3]).toBe(84 + 260 - 80);
  });

  it("stops where the column giving way reaches its floor on screen", () => {
    // At half scale the mods column's 56 pixel floor is 112 stored pixels, so
    // the line in front of it travels 18 stored pixels and stops.
    const traded = withBoundaryTraded(WIDTHS, 6, 5000, floorAt(FLOORS, 0.5));
    expect(traded[6]).toBe(112);
    expect(traded[5]).toBe(150 + 130 - 112);
  });

  it("moves a column drawn at its floor from the first pixel", () => {
    // Stored at 40 but drawn at its 108 floor: it is lifted to 108 first,
    // which changes nothing on screen, so the line moves at once rather than
    // waiting for 68 pixels of drag to catch up.
    const stored = [...WIDTHS];
    stored[7] = 40;
    const traded = withBoundaryTraded(stored, 7, -10, floorAt(FLOORS, 1));
    expect(traded[7]).toBe(118);
    expect(traded[6]).toBe(120);
  });

  it("leaves every other column where it was, and the line under the pointer", () => {
    // Fitted into 700 pixels, a drag of 20 drawn pixels on the line between
    // the host and the mods column: converted at the fit's scale, traded,
    // and fitted again.
    const before = fitColumns(WIDTHS, FLOORS, 700);
    const traded = withBoundaryTraded(WIDTHS, 6, 20 / before.scale, floorAt(FLOORS, before.scale));
    const after = fitColumns(traded, FLOORS, 700);
    // The host column grew by the pointer's distance and the mods column gave
    // it up, give or take the pixel the rounding moves.
    expect(Math.abs(after.drawn[5] - (before.drawn[5] + 20))).toBeLessThanOrEqual(1);
    expect(Math.abs(after.drawn[6] - (before.drawn[6] - 20))).toBeLessThanOrEqual(1);
    for (const index of [0, 1, 2, 3, 4, 7]) {
      expect(Math.abs(after.drawn[index] - before.drawn[index])).toBeLessThanOrEqual(1);
    }
  });

  it("does nothing when every column is at its floor", () => {
    const fit = fitColumns(WIDTHS, FLOORS, 300);
    const traded = withBoundaryTraded(WIDTHS, 4, 40 / fit.scale, floorAt(FLOORS, fit.scale));
    expect(fitColumns(traded, FLOORS, 300).drawn).toEqual(FLOORS);
  });

  it("ignores a line that has no column on one side of it", () => {
    const floor = () => MIN_BROWSER_COLUMN_PX;
    expect(withBoundaryTraded(WIDTHS, 0, 40, floor)).toEqual(WIDTHS);
    expect(withBoundaryTraded(WIDTHS, WIDTHS.length, 40, floor)).toEqual(WIDTHS);
  });
});
