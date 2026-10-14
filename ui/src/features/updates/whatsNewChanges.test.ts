import { describe, expect, it } from "vitest";
import type { ChangelogBlock, ChangelogListItem } from "../../ipc/bindings";
import { whatsNewChanges } from "./whatsNewChanges";

const item = (text: string, children: ChangelogListItem[] = []): ChangelogListItem => ({
  spans: [{ type: "text", payload: text }],
  change: null,
  children,
});

const heading = (text: string, level = 3): ChangelogBlock => ({ type: "heading", payload: { level, text } });
const list = (...texts: string[]): ChangelogBlock => ({ type: "list", payload: { items: texts.map((text) => item(text)) } });
const texts = (items: ChangelogListItem[]) =>
  items.map(({ spans: [span] }) => (span?.type === "text" ? span.payload : ""));

/** Seven features and two fixes, the way `scripts/changelog.mjs` lays them out. */
const SECTIONS: ChangelogBlock[] = [
  heading("Features"),
  list("F1", "F2", "F3", "F4", "F5", "F6", "F7"),
  heading("Bug fixes"),
  list("B1", "B2"),
];

describe("whatsNewChanges", () => {
  it("shows the highlights and counts every change in the other sections", () => {
    const changes = whatsNewChanges([heading("Highlights"), list("H1", "H2", "H3"), ...SECTIONS]);
    expect(texts(changes.shown)).toEqual(["H1", "H2", "H3"]);
    expect(changes.highlights).toBe(true);
    expect(changes.rest).toBe(9);
  });

  it("finds the heading whatever its case, and wherever it is", () => {
    const changes = whatsNewChanges([...SECTIONS, heading(" HIGHLIGHTS "), list("H1")]);
    expect(texts(changes.shown)).toEqual(["H1"]);
    expect(changes.rest).toBe(9);
  });

  it("shows five highlights at most", () => {
    const changes = whatsNewChanges([heading("Highlights"), list("H1", "H2", "H3", "H4", "H5", "H6"), ...SECTIONS]);
    expect(texts(changes.shown)).toEqual(["H1", "H2", "H3", "H4", "H5"]);
    expect(changes.rest).toBe(9);
  });

  it("ends the highlights at the next heading of their level, not at a sub-heading", () => {
    const changes = whatsNewChanges([
      heading("Highlights"),
      list("H1"),
      heading("Online play", 4),
      list("H2"),
      ...SECTIONS,
    ]);
    expect(texts(changes.shown)).toEqual(["H1", "H2"]);
    expect(changes.rest).toBe(9);
  });

  it("counts top-level lines only: a nested line belongs to the one above it", () => {
    const nested: ChangelogBlock = { type: "list", payload: { items: [item("F1", [item("detail")]), item("F2")] } };
    const changes = whatsNewChanges([heading("Highlights"), list("H1"), heading("Features"), nested]);
    expect(changes.rest).toBe(2);
  });

  it("without highlights, shows the first five lines and counts the rest", () => {
    const changes = whatsNewChanges(SECTIONS);
    expect(texts(changes.shown)).toEqual(["F1", "F2", "F3", "F4", "F5"]);
    expect(changes.highlights).toBe(false);
    expect(changes.rest).toBe(4);
  });

  it("falls back to the first lines when the highlights heading has none under it", () => {
    const prose: ChangelogBlock = { type: "paragraph", payload: { spans: [{ type: "text", payload: "A big one." }] } };
    const changes = whatsNewChanges([heading("Highlights"), prose, ...SECTIONS]);
    expect(texts(changes.shown)).toEqual(["F1", "F2", "F3", "F4", "F5"]);
    expect(changes.highlights).toBe(false);
  });

  it("shows nothing for a release that lists nothing", () => {
    const prose: ChangelogBlock = { type: "paragraph", payload: { spans: [{ type: "text", payload: "Maintenance." }] } };
    expect(whatsNewChanges([prose])).toEqual({ shown: [], highlights: false, rest: 0 });
    expect(whatsNewChanges([])).toEqual({ shown: [], highlights: false, rest: 0 });
  });
});
