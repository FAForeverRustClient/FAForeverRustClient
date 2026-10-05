// The guide reader's one rule worth pinning: what it takes out of a guide
// because the page around it already says it.

import { describe, expect, it } from "vitest";
import { guideOutline } from "./GuideReader";

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
});
