// The parser behind an organiser's formatted prose.
//
// Half of these cases are about formatting and half are about what must never
// come out of it: a url that is not `https`, an image path that resolves
// nowhere, and markup that has to stay text. The parse is the only place those
// decisions are made, because the renderer emits elements and cannot be made to
// emit markup by anything in the input.

import { describe, expect, it } from "vitest";
import { markdownToText, parseMarkdown, unplacedImages } from "./markdown";

const BASE = "https://tournaments.example.invalid";

/** The text of a block, ignoring which spans it was built from. */
const textOf = (block: ReturnType<typeof parseMarkdown>[number]): string =>
  block.kind === "image" ? block.alt : block.spans.map((s) => ("text" in s ? s.text : "")).join("");

describe("parseMarkdown", () => {
  it("reads headings, bullets and plain lines", () => {
    const blocks = parseMarkdown("# Rules\n- Best of three\nPlay well.");
    expect(blocks.map((block) => block.kind)).toEqual(["heading", "bullet", "paragraph"]);
    expect(blocks[0].kind === "heading" && blocks[0].level).toBe(1);
    expect(textOf(blocks[1])).toBe("Best of three");
  });

  it("keeps a blank line as a blank line", () => {
    // The service's editor is line-based and so is the display: a gap the
    // organiser typed is a gap they meant.
    expect(parseMarkdown("a\n\nb")).toHaveLength(3);
  });

  it("marks bold, italic and underline", () => {
    const marks = [
      ["**loud**", "bold"],
      ["*aside*", "italic"],
      ["__stressed__", "underline"],
    ] as const;
    for (const [source, mark] of marks) {
      const [line] = parseMarkdown(source);
      if (line.kind !== "paragraph") throw new Error("expected a paragraph");
      const marked = line.spans.find((span) => span.kind === "text" && span[mark]);
      expect(marked, source).toBeDefined();
      expect(textOf(line)).not.toContain("*");
    }
  });

  it("does not nest one emphasis inside another, exactly as the website does not", () => {
    // Worth pinning rather than fixing: the service's own renderer refuses the
    // same shape (its bold pattern forbids a `*` inside), so making this work
    // here would show an organiser a preview their own site disagrees with.
    const [line] = parseMarkdown("**very *odd* text**");
    if (line.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(line.spans.some((span) => span.kind === "text" && span.bold)).toBe(false);
  });

  it("makes a link out of https and plain text out of anything else", () => {
    const [ok] = parseMarkdown("see the [rules](https://x.invalid/r)");
    if (ok.kind !== "paragraph") throw new Error("expected a paragraph");
    expect(ok.spans.some((span) => span.kind === "link")).toBe(true);

    // The three that must never become clickable. `http` is refused too: the
    // client's opener takes https only, so a link it would refuse on click is
    // better drawn as the words it is.
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "http://x.invalid"]) {
      const [line] = parseMarkdown(`go [here](${bad})`);
      if (line.kind !== "paragraph") throw new Error("expected a paragraph");
      expect(line.spans.some((span) => span.kind === "link")).toBe(false);
      expect(textOf(line)).toContain("here");
    }
  });

  it("resolves the service's own image paths against the base and refuses the rest", () => {
    const [placed] = parseMarkdown("![a](/desc-images/a1b2.png)", BASE);
    expect(placed).toEqual({ kind: "image", url: `${BASE}/desc-images/a1b2.png`, alt: "a" });

    // A traversing path is not one of the service's own, whatever it looks like.
    const [escaped] = parseMarkdown("![a](/desc-images/../../etc/passwd)", BASE);
    expect(escaped.kind).toBe("paragraph");

    // With no base there is no server to load from, which is the offline fake.
    // The alt text survives rather than the line going blank.
    const [offline] = parseMarkdown("![a screenshot](/desc-images/a1b2.png)", "");
    expect(offline.kind).toBe("paragraph");
    expect(textOf(offline)).toBe("a screenshot");
  });

  it("leaves markup as text, which is the whole reason the source is kept", () => {
    const [line] = parseMarkdown("<script>alert(1)</script> and <img onerror=x>");
    if (line.kind !== "paragraph") throw new Error("expected a paragraph");
    // One text span, containing the characters. Nothing here can produce an
    // element out of them, and the renderer has no path that would either.
    expect(line.spans).toHaveLength(1);
    expect(textOf(line)).toBe("<script>alert(1)</script> and <img onerror=x>");
  });

  it("does not mistake an image for a link", () => {
    const [line] = parseMarkdown("![alt](https://x.invalid/a.png)", BASE);
    expect(line.kind).toBe("image");
  });
});

describe("markdownToText", () => {
  it("strips the syntax rather than showing it", () => {
    expect(markdownToText("## Rules\n- **Bo3** every round\n[link](https://x.invalid)")).toBe(
      "Rules Bo3 every round link",
    );
  });
});

describe("unplacedImages", () => {
  it("keeps only what no body referenced", () => {
    const files = ["a1b2.png", "c3d4.png"];
    const bodies = ["see ![x](/desc-images/a1b2.png)", ""];
    expect(unplacedImages(files, bodies)).toEqual(["c3d4.png"]);
  });

  it("matches a percent-encoded reference too", () => {
    // The service hands back an encoded url while storing the bare name, so
    // comparing one against the other would show every placed image twice.
    expect(unplacedImages(["a b.png"], ["![x](/desc-images/a%20b.png)"])).toEqual([]);
  });
});
