import { describe, expect, it } from "vitest";
import type { ChangelogBlock, ChangelogListItem } from "../../ipc/bindings";
import { whatsNewSections } from "./whatsNewChanges";

const item = (text: string, children: ChangelogListItem[] = []): ChangelogListItem => ({
  spans: [{ type: "text", payload: text }],
  change: null,
  children,
});

const heading = (text: string, level = 3): ChangelogBlock => ({ type: "heading", payload: { level, text } });
const list = (...texts: string[]): ChangelogBlock => ({ type: "list", payload: { items: texts.map((text) => item(text)) } });
const texts = (items: ChangelogListItem[]) =>
  items.map(({ spans: [span] }) => (span?.type === "text" ? span.payload : ""));
/** Each section as its heading and its lines. */
const shape = (blocks: ChangelogBlock[]) =>
  whatsNewSections(blocks).map((section) => [section.heading, texts(section.items)]);

/** Seven features and two fixes, the way `scripts/changelog.mjs` lays them out. */
const SECTIONS: ChangelogBlock[] = [
  heading("Features"),
  list("F1", "F2", "F3", "F4", "F5", "F6", "F7"),
  heading("Bug fixes"),
  list("B1", "B2"),
];

describe("whatsNewSections", () => {
  it("lists every change, the highlights first and then each section in order", () => {
    expect(shape([heading("Highlights"), list("H1", "H2", "H3", "H4", "H5", "H6"), ...SECTIONS])).toEqual([
      ["Highlights", ["H1", "H2", "H3", "H4", "H5", "H6"]],
      ["Features", ["F1", "F2", "F3", "F4", "F5", "F6", "F7"]],
      ["Bug fixes", ["B1", "B2"]],
    ]);
  });

  it("puts the highlights first wherever the notes have them, whatever the heading's case", () => {
    expect(shape([...SECTIONS, heading(" HIGHLIGHTS "), list("H1")])).toEqual([
      ["HIGHLIGHTS", ["H1"]],
      ["Features", ["F1", "F2", "F3", "F4", "F5", "F6", "F7"]],
      ["Bug fixes", ["B1", "B2"]],
    ]);
  });

  it("keeps a sub-heading's lines in the section above it", () => {
    expect(shape([heading("Highlights"), list("H1"), heading("Online play", 4), list("H2"), ...SECTIONS])[0]).toEqual([
      "Highlights",
      ["H1", "H2"],
    ]);
  });

  it("keeps a nested line under the one above it", () => {
    const nested: ChangelogBlock = { type: "list", payload: { items: [item("F1", [item("detail")]), item("F2")] } };
    const [features] = whatsNewSections([heading("Features"), nested]);
    expect(texts(features.items)).toEqual(["F1", "F2"]);
    expect(texts(features.items[0].children)).toEqual(["detail"]);
  });

  it("lists a release without highlights section by section", () => {
    expect(shape(SECTIONS)).toEqual([
      ["Features", ["F1", "F2", "F3", "F4", "F5", "F6", "F7"]],
      ["Bug fixes", ["B1", "B2"]],
    ]);
  });

  it("leaves out a section with no lines, and keeps lines that come before any heading", () => {
    const prose: ChangelogBlock = { type: "paragraph", payload: { spans: [{ type: "text", payload: "A big one." }] } };
    expect(shape([list("L1"), heading("Highlights"), prose, ...SECTIONS])).toEqual([
      [null, ["L1"]],
      ["Features", ["F1", "F2", "F3", "F4", "F5", "F6", "F7"]],
      ["Bug fixes", ["B1", "B2"]],
    ]);
  });

  it("lists nothing for a release that lists nothing", () => {
    const prose: ChangelogBlock = { type: "paragraph", payload: { spans: [{ type: "text", payload: "Maintenance." }] } };
    expect(whatsNewSections([prose])).toEqual([]);
    expect(whatsNewSections([])).toEqual([]);
  });
});
