import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOGUES } from "../../../i18n/catalog";
import { designedOrder, resolveColumnOrder, withColumnMoved } from "../../../shared/hooks/useColumnOrder";
import { fitColumns, withBoundaryTraded } from "../../../shared/tableColumns";
import {
  COLUMN_FLOORS,
  columnTemplate,
  columnWidths,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_DETAIL_WIDTH,
  detailWidth,
  emptyDetailGivesWay,
  listWidthFor,
  ROW_PADDING_PX,
  withDetailResized,
} from "./browserLayout";
import {
  MAX_DETAIL_PX,
  MIN_DETAIL_PX,
} from "../../../shared/browsingPreferences";

/**
 * What each heading needs in English, measured in the client: the label, the
 * five pixel gap and the sort arrow (the tags heading has no arrow).
 */
const HEADINGS = [49, 30, 42, 64, 72, 38];
/** The headings' keys, in the designed order. */
const HEADING_KEYS = [
  "lobby.browser.column.game",
  "lobby.browser.column.tags",
  "lobby.browser.column.map",
  "lobby.browser.column.players",
  "lobby.browser.column.rating",
  "lobby.browser.column.age",
] as const;

/**
 * Every language's headings, measured the same way as `HEADINGS` (Segoe UI,
 * which the default theme falls back to on Windows: 11 px, semibold, spaced
 * and in capitals, with the gap and the sort arrow). A heading that is not
 * here has not been measured: measure it and add it rather than guess.
 */
const MEASURED_HEADINGS: readonly Readonly<Record<string, number>>[] = [
  { Game: 49, Partie: 54, Partida: 64, Gra: 39, "Игра": 45 },
  { Tags: 30, Etiquetas: 63, Tagi: 27, "Теги": 29 },
  { Map: 41, Karte: 51, Mapa: 49, Carte: 51, "Карта": 52 },
  { Players: 64, Spieler: 60, Plazas: 59, Joueurs: 67, Gracze: 60, "Игроков": 70 },
  { "Ø Rating": 71, "Ø-Rating": 73, "Ø Puntos": 75, "Ø Niveau": 72, Ranking: 69, "Рейтинг": 69 },
  { Age: 38, Alter: 50, Edad: 47, "Âge": 38, Wiek: 44, "Возр.": 47 },
];

/** The list and the panel beside it together, in the default 1100 by 720 window. */
const LAYOUT_AT_1100 = 820;
/** The same at 1600 pixels. */
const LAYOUT_AT_1600 = 1320;
/** What the list's frame, padding and gaps take from its own width. */
const LIST_CHROME = listWidthFor(DEFAULT_COLUMN_WIDTHS) - DEFAULT_COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0);

const stylesheet = readFileSync(fileURLToPath(new URL("./custom-games.css", import.meta.url)), "utf8");
const tokens = readFileSync(fileURLToPath(new URL("../../../design-system/tokens.css", import.meta.url)), "utf8");

/** A length from the stylesheet in pixels, a spacing token resolved through `tokens.css`. */
function pixels(value: string): number {
  const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (!token) return Number.parseFloat(value);
  const declared = new RegExp(`${token}:\\s*([\\d.]+)px`).exec(tokens)?.[1];
  if (declared === undefined) throw new Error(`${token} is not declared in pixels`);
  return Number(declared);
}

/**
 * The left and right padding `selector` is given, from the rules that end
 * with it (`.game-browser-row` is also the second half of the rule it shares
 * with the header); the last one to set a padding wins, as in the cascade.
 */
function sidePadding(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paddings = [...stylesheet.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))]
    .map((rule) => /(?:^|[;\n])\s*padding:\s*([^;]+);/.exec(rule[1])?.[1].trim().split(/\s+/))
    .filter((padding) => padding !== undefined);
  const padding = paddings[paddings.length - 1];
  if (!padding) throw new Error(`no padding on ${selector}`);
  return pixels(padding[1] ?? padding[0]);
}

describe("the game list's padding", () => {
  it("pads the header and the rows alike, by what the fitting assumes", () => {
    // One column template for the header and every row, so a difference in
    // padding moves every cell off the divider above it. The header had 16
    // pixels to the rows' 12, which put each column 4 pixels off its label.
    expect(sidePadding(".game-browser-row")).toBe(sidePadding(".game-browser-head"));
    expect(sidePadding(".game-browser-head")).toBe(ROW_PADDING_PX);
  });
});

describe("the game list's column widths", () => {
  it("falls back to the designed width for anything not stored", () => {
    // Empty, short and over-long are all "use the design for the rest": a
    // release that adds or drops a column must not leave the list unusable.
    expect(columnWidths([])).toEqual([...DEFAULT_COLUMN_WIDTHS]);
    expect(columnWidths([400])).toEqual([400, ...DEFAULT_COLUMN_WIDTHS.slice(1)]);
    expect(columnWidths([400, 0, 0, 0, 0, 0, 999])).toEqual([
      400,
      ...DEFAULT_COLUMN_WIDTHS.slice(1),
    ]);
    expect(columnWidths(undefined)).toEqual([...DEFAULT_COLUMN_WIDTHS]);
  });

  it("reads a set saved before the tags column as the columns it described", () => {
    // Five widths are game, map, players, rating and age. Taken position by
    // position the map's width would become the tags column's, and every
    // column after it would shift one place along.
    expect(columnWidths([400, 210, 90, 110, 80])).toEqual([
      400,
      DEFAULT_COLUMN_WIDTHS[1],
      210,
      90,
      110,
      80,
    ]);
  });

  it("has room for a title, a map name and every heading in the default window", () => {
    // The details panel steps aside while it is empty (below), so the list
    // has the whole 820 pixels. The set this replaced drew every column at
    // three quarters there: titles, map names and three headings were cut.
    const fit = fitColumns(DEFAULT_COLUMN_WIDTHS, COLUMN_FLOORS, LAYOUT_AT_1100 - LIST_CHROME);
    expect(fit.overflow).toBe(false);
    fit.drawn.forEach((width, index) => expect(width).toBeGreaterThanOrEqual(HEADINGS[index]));
    // A thumbnail, its gap and about 200 pixels of title and host.
    expect(fit.drawn[0]).toBeGreaterThanOrEqual(240);
    // "Astro Crater Battles 4x4" is 129 pixels.
    expect(fit.drawn[2]).toBeGreaterThanOrEqual(140);
  });

  it("has room for every heading in every language in the default window", () => {
    // "Antigüedad", "Ouverte depuis" and "Создано" were each about 40 pixels
    // wider than the 52 pixel age column, and three rating headings and the
    // Spanish players heading were cut as well. Those languages now use a
    // shorter word there, and the whole name is in the heading's tooltip.
    const fit = fitColumns(DEFAULT_COLUMN_WIDTHS, COLUMN_FLOORS, LAYOUT_AT_1100 - LIST_CHROME);
    for (const [language, catalogue] of Object.entries(CATALOGUES)) {
      HEADING_KEYS.forEach((key, column) => {
        const message = catalogue[key] ?? CATALOGUES.en[key];
        // A heading is one string, never a plural form.
        const heading = typeof message === "string" ? message : "";
        const width = MEASURED_HEADINGS[column][heading] as number | undefined;
        expect(width, `${language} "${heading}" has not been measured`).toBeDefined();
        expect(width, `${language} "${heading}"`).toBeLessThanOrEqual(fit.drawn[column]);
      });
    }
  });

  it("still fits beside the details panel once a game is picked", () => {
    // 820 less the panel and its divider: the columns narrow, and none goes
    // under its floor or off the edge.
    const list = LAYOUT_AT_1100 - 12 - DEFAULT_DETAIL_WIDTH;
    const fit = fitColumns(DEFAULT_COLUMN_WIDTHS, COLUMN_FLOORS, list - LIST_CHROME);
    expect(fit.overflow).toBe(false);
    fit.drawn.forEach((width, index) => expect(width).toBeGreaterThanOrEqual(COLUMN_FLOORS[index]));
  });

  it("stops the game column at a readable width", () => {
    // The game column trades width like any other, down to its floor.
    const widths = [...DEFAULT_COLUMN_WIDTHS];
    const traded = withBoundaryTraded(widths, 1, -5000, (index) => COLUMN_FLOORS[index]);
    expect(traded[0]).toBe(COLUMN_FLOORS[0]);
    expect(traded[1]).toBe(widths[1] + widths[0] - COLUMN_FLOORS[0]);
  });

  it("moves a column to where it is dropped", () => {
    expect(withColumnMoved([0, 1, 2, 3, 4, 5], 0, 3)).toEqual([1, 2, 3, 0, 4, 5]);
    expect(withColumnMoved([0, 1, 2, 3, 4, 5], 5, 0)).toEqual([5, 0, 1, 2, 3, 4]);
    expect(resolveColumnOrder([], 6)).toEqual(designedOrder(6));
    expect(resolveColumnOrder([5, 4, 3, 2, 1, 0], 6)).toEqual([5, 4, 3, 2, 1, 0]);
    // An order saved for a table with a different number of columns.
    expect(resolveColumnOrder([1, 0], 6)).toEqual(designedOrder(6));
  });

  it("gives the game column the slack wherever it is drawn, never less than its floor", () => {
    expect(columnTemplate([96, 254, 150], 1)).toBe("96px minmax(160px, 1fr) 150px");
  });

  it("gives the game column whatever the other five leave", () => {
    // Not a track of its own at the end: the list then stopped a third of the
    // way across a wide window, with the titles beside it still cut off.
    expect(columnTemplate([254, 96, 150, 72, 80, 52])).toBe(
      "minmax(160px, 1fr) 96px 150px 72px 80px 52px",
    );
  });
});

describe("the empty details panel", () => {
  it("steps aside where the list beside it would be squeezed", () => {
    expect(emptyDetailGivesWay(LAYOUT_AT_1100, DEFAULT_DETAIL_WIDTH, DEFAULT_COLUMN_WIDTHS)).toBe(true);
  });

  it("stays where there is room for both", () => {
    expect(emptyDetailGivesWay(LAYOUT_AT_1600, DEFAULT_DETAIL_WIDTH, DEFAULT_COLUMN_WIDTHS)).toBe(false);
  });

  it("asks for the room the stored widths need, and a wider panel needs more", () => {
    const wide = DEFAULT_COLUMN_WIDTHS.map((width) => width + 100);
    expect(emptyDetailGivesWay(LAYOUT_AT_1600, DEFAULT_DETAIL_WIDTH, wide)).toBe(true);
    expect(emptyDetailGivesWay(LAYOUT_AT_1600, MAX_DETAIL_PX, DEFAULT_COLUMN_WIDTHS)).toBe(true);
  });

  it("stays put before the layout has been measured", () => {
    expect(emptyDetailGivesWay(0, DEFAULT_DETAIL_WIDTH, DEFAULT_COLUMN_WIDTHS)).toBe(false);
  });
});

describe("the details panel's width", () => {
  it("widens as the divider is dragged towards the list", () => {
    // The handle is on the panel's left edge, so left is wider.
    expect(withDetailResized(300, -40)).toBe(340);
    expect(withDetailResized(300, 40)).toBe(260);
  });

  it("stays between a readable preview and a usable game list", () => {
    expect(withDetailResized(300, -5000)).toBe(MAX_DETAIL_PX);
    expect(withDetailResized(300, 5000)).toBe(MIN_DETAIL_PX);
  });

  it("reads an unset width as the designed one", () => {
    expect(detailWidth(0)).toBe(DEFAULT_DETAIL_WIDTH);
    expect(detailWidth(undefined)).toBe(DEFAULT_DETAIL_WIDTH);
    expect(detailWidth(400)).toBe(400);
  });
});
