// The guide reader's one rule worth pinning: what it takes out of a guide
// because the page around it already says it.

import { describe, expect, it } from "vitest";
import { guideOutline, guideSegments } from "./GuideReader";
import { parseBlocks } from "./markdown";

describe("guideOutline", () => {
  it("takes the title and the byline out, and keeps the original's address", () => {
    const outline = guideOutline(
      [
        "# Beginner's guide",
        "",
        "By the FAF wiki. [The original](https://wiki.faforever.com/Play/Guide).",
        "",
        "## Introduction",
        "",
        "Welcome.",
      ].join("\n"),
    );
    expect(outline.source).toBe("https://wiki.faforever.com/Play/Guide");
    expect(outline.blocks).toEqual([
      { kind: "heading", level: 2, text: "Introduction" },
      { kind: "paragraph", text: "Welcome." },
    ]);
  });

  it("takes a byline that names no original", () => {
    const outline = guideOutline(
      ["# Arcane", "", "A 1v1 build order by Sladow-Noob.", "", "## Build"].join("\n"),
    );
    expect(outline.source).toBeNull();
    expect(outline.blocks).toEqual([{ kind: "heading", level: 2, text: "Build" }]);
  });

  it("keeps an opening paragraph that is not a byline", () => {
    const outline = guideOutline("# Title\n\nAlways scout [first](https://example.com).");
    expect(outline.source).toBeNull();
    expect(outline.blocks).toEqual([
      { kind: "paragraph", text: "Always scout [first](https://example.com)." },
    ]);
  });

  it("keeps a guide that does not open with its title", () => {
    const outline = guideOutline("## Build\n\n- fac");
    expect(outline.blocks[0]).toEqual({ kind: "heading", level: 2, text: "Build" });
  });

  it("drops a rule that would double a section's hairline", () => {
    // The shape of the wiki's beginner 1v1 guide: a rule before a section,
    // two in a row, one under a section heading, and one at the very end.
    const outline = guideOutline(
      ["Intro.", "", "---", "## Openers", "---", "Text.", "", "___", "***", "## Economy", "", "___"].join(
        "\n",
      ),
    );
    expect(outline.blocks).toEqual([
      { kind: "paragraph", text: "Intro." },
      { kind: "heading", level: 2, text: "Openers" },
      { kind: "paragraph", text: "Text." },
      { kind: "heading", level: 2, text: "Economy" },
    ]);
  });

  it("keeps a rule an author put between two paragraphs", () => {
    const outline = guideOutline("## Part\n\nOne.\n\n---\n\nTwo.");
    expect(outline.blocks).toEqual([
      { kind: "heading", level: 2, text: "Part" },
      { kind: "paragraph", text: "One." },
      { kind: "rule" },
      { kind: "paragraph", text: "Two." },
    ]);
  });
});

describe("guideSegments", () => {
  it("lays a wiki tabset out as tabs, up to the next heading at its level", () => {
    const blocks = parseBlocks(
      [
        "## Spending Resources",
        "## Spending Resources{.tabset}",
        "### Mass",
        "Mexes.",
        "",
        "#### Reclaim",
        "Rocks.",
        "",
        "### Energy",
        "Pgens.",
        "",
        "## Basic Strategy",
      ].join("\n"),
    );
    const segments = guideSegments(blocks);
    expect(segments.map((segment) => segment.kind)).toEqual(["block", "tabs", "block"]);
    const tabs = segments[1];
    if (tabs.kind !== "tabs") throw new Error("expected tabs");
    expect(tabs.lead).toEqual([]);
    expect(tabs.tabs.map((tab) => tab.heading.block.text)).toEqual(["Mass", "Energy"]);
    // A deeper heading is part of its tab's text, not a tab of its own.
    expect(tabs.tabs[0].body.map((placed) => placed.block.kind)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
    ]);
    expect(tabs.tabs[1].body).toEqual([{ block: { kind: "paragraph", text: "Pgens." }, index: 7 }]);
  });

  it("keeps text before the first tab above the tabs", () => {
    const segments = guideSegments(parseBlocks("## A{.tabset}\nIntro.\n\n### One\nText."));
    expect(segments).toHaveLength(1);
    const tabs = segments[0];
    if (tabs.kind !== "tabs") throw new Error("expected tabs");
    expect(tabs.lead.map((placed) => placed.block)).toEqual([{ kind: "paragraph", text: "Intro." }]);
    expect(tabs.tabs).toHaveLength(1);
  });

  it("lays out a tabset with nothing to tab between as plain text", () => {
    expect(guideSegments(parseBlocks("## A{.tabset}\nJust text."))).toEqual([
      { kind: "block", placed: { block: { kind: "paragraph", text: "Just text." }, index: 1 } },
    ]);
  });
});
