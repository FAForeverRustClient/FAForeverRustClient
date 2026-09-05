// The two parts of the submission editor that can be wrong without looking
// wrong: the block/inline parse, and the toolbar's selection arithmetic. A
// prefix applied to the wrong line still renders as a working button.

import { describe, expect, it } from "vitest";
import { parseBlocks, parseSpans } from "./markdown";
import { applyAction } from "./MarkdownField";

describe("markdown blocks", () => {
  it("reads the shapes a guide is actually written in", () => {
    const source = [
      "## Opening",
      "",
      "Build four mexes, then a land factory.",
      "Keep the queue full.",
      "",
      "- scout early",
      "- expand second",
      "",
      "1. first",
      "2. second",
      "",
      "> A note from a trainer",
      "",
      "```",
      "  indented build order",
      "```",
    ].join("\n");

    expect(parseBlocks(source)).toEqual([
      { kind: "heading", level: 2, text: "Opening" },
      // Consecutive lines are one paragraph, the way Markdown reads them.
      { kind: "paragraph", text: "Build four mexes, then a land factory. Keep the queue full." },
      { kind: "list", ordered: false, items: ["scout early", "expand second"] },
      { kind: "list", ordered: true, items: ["first", "second"] },
      { kind: "quote", text: "A note from a trainer" },
      // Fenced code keeps its own whitespace: a build order pasted into a
      // guide is the main thing anyone puts in a fence, and reflowing it
      // would ruin it.
      { kind: "code", text: "  indented build order" },
    ]);
  });

  it("gives a single hash its own level, above two", () => {
    // These collapsed into one level while the destination was a forum post
    // whose title was a separate field: there was nothing for the top level to
    // mean. A guide is a document of its own, so its sections have to look
    // like sections and `#` has to outrank `##`.
    expect(parseBlocks("# Title")).toEqual([{ kind: "heading", level: 1, text: "Title" }]);
    expect(parseBlocks("## Section")).toEqual([{ kind: "heading", level: 2, text: "Section" }]);
    expect(parseBlocks("### Deeper")).toEqual([{ kind: "heading", level: 3, text: "Deeper" }]);
  });

  it("flattens anything deeper than three, because a preview is not an outline", () => {
    for (const source of ["#### Four", "##### Five", "###### Six"]) {
      expect(parseBlocks(source)).toEqual([
        { kind: "heading", level: 3, text: source.replace(/^#+ /, "") },
      ]);
    }
  });

  it("does not lose the last block when the source ends without a newline", () => {
    expect(parseBlocks("one last thought")).toHaveLength(1);
    expect(parseBlocks("```\nunclosed")).toEqual([{ kind: "code", text: "unclosed" }]);
  });

  it("handles Windows line endings, which is what a pasted guide has", () => {
    expect(parseBlocks("## A\r\n\r\nbody")).toEqual([
      { kind: "heading", level: 2, text: "A" },
      { kind: "paragraph", text: "body" },
    ]);
  });
});

describe("markdown spans", () => {
  it("reads emphasis, code and links", () => {
    expect(parseSpans("plain **bold** and _italic_ and `code`")).toEqual([
      { kind: "text", text: "plain " },
      { kind: "strong", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "em", text: "italic" },
      { kind: "text", text: " and " },
      { kind: "code", text: "code" },
    ]);
  });

  it("keeps a link whose destination is ordinary HTTPS", () => {
    expect(parseSpans("see [the wiki](https://wiki.faforever.com)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "the wiki", href: "https://wiki.faforever.com/" },
    ]);
  });

  it("renders a link it will not follow as text rather than as an anchor", () => {
    // The same rule the rest of the client applies to a URL it did not write.
    // The preview must never produce an anchor it has not validated.
    for (const bad of ["javascript:alert(1)", "http://example.invalid", "file:///etc/passwd"]) {
      const spans = parseSpans(`[click](${bad})`);
      expect(spans.every((span) => span.kind !== "link")).toBe(true);
      expect(spans.map((span) => span.text).join("")).toBe(`[click](${bad})`);
    }
  });

  it("leaves an unterminated marker alone instead of eating the rest", () => {
    expect(parseSpans("a **broken")).toEqual([{ kind: "text", text: "a **broken" }]);
  });
});

describe("the toolbar's selection arithmetic", () => {
  it("wraps the selection and keeps it selected", () => {
    const result = applyAction("build fast", 0, 5, { kind: "wrap", before: "**", after: "**" });
    expect(result.value).toBe("**build** fast");
    expect(result.value.slice(result.start, result.end)).toBe("build");
  });

  it("wraps nothing into an empty pair when there is no selection", () => {
    // The caret lands between the markers, so typing continues inside them.
    const result = applyAction("ab", 1, 1, { kind: "wrap", before: "`", after: "`" });
    expect(result.value).toBe("a``b");
    expect(result.start).toBe(2);
    expect(result.end).toBe(2);
  });

  it("prefixes the line the caret is on, not the document", () => {
    const result = applyAction("first\nsecond\nthird", 8, 8, { kind: "prefix", prefix: "- " });
    expect(result.value).toBe("first\n- second\nthird");
  });

  it("prefixes every line a multi-line selection touches", () => {
    const source = "one\ntwo\nthree";
    // From inside the first line to inside the second.
    const result = applyAction(source, 1, 5, { kind: "prefix", prefix: "- " });
    expect(result.value).toBe("- one\n- two\nthree");
  });

  it("prefixes the first line when the caret is at the very start", () => {
    const result = applyAction("only", 0, 0, { kind: "prefix", prefix: "## " });
    expect(result.value).toBe("## only");
  });
});
