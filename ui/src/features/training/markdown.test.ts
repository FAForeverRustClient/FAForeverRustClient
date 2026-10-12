// The two parts of the submission editor that can be wrong without looking
// wrong: the block/inline parse, and the toolbar's selection arithmetic. A
// prefix applied to the wrong line still renders as a working button.

import { describe, expect, it } from "vitest";
import {
  clock,
  parseBlocks,
  parseSpans,
  resolveAddress,
  resolveImage,
  resolveLink,
  soleVideo,
  tableCells,
  videoStart,
} from "./markdown";
import {
  applyAction,
  factionTabs,
  paragraphBreak,
  pictureAt,
  withPicture,
} from "./MarkdownField";

describe("a guide's own pictures", () => {
  const document = "https://raw.githubusercontent.com/o/guides/main/guides/setons-air.md";
  const page = "https://wiki.faforever.com/Play/Learning/Unit-Micro";

  it("resolve beside the guide when the path is relative to it", () => {
    expect(resolveImage("images/setons-air/opening.png", { document })).toBe(
      "https://raw.githubusercontent.com/o/guides/main/guides/images/setons-air/opening.png",
    );
    expect(parseSpans("![The opening](images/setons-air/opening.png)", { document, page })).toEqual([
      {
        kind: "image",
        text: "The opening",
        src: "https://raw.githubusercontent.com/o/guides/main/guides/images/setons-air/opening.png",
      },
    ]);
  });

  it("still mean the copied page's site when rooted, like a link", () => {
    expect(resolveImage("/images/learning/hold_fire.png", { document, page })).toBe(
      "https://wiki.faforever.com/images/learning/hold_fire.png",
    );
    // A link is never resolved against the guide's file.
    expect(resolveAddress("other.md", { document })).toBeNull();
  });

  it("show an attached picture from the client's own copy until it is sent", () => {
    const local = new Map([["images/opening.png", "blob:http://localhost/1234"]]);
    expect(resolveImage("images/opening.png", { local })).toBe("blob:http://localhost/1234");
    // Anything not attached is not fetched from a guessed address.
    expect(resolveImage("images/other.png", { local })).toBeNull();
    expect(resolveImage("javascript:alert(1)", { local, document })).toBeNull();
  });
});

describe("inserting a picture", () => {
  it("puts it in a paragraph of its own", () => {
    expect(paragraphBreak("", "end")).toBe("");
    expect(paragraphBreak("A sentence.", "end")).toBe("\n\n");
    expect(paragraphBreak("A sentence.\n", "end")).toBe("\n");
    expect(paragraphBreak("A sentence.\n\n", "end")).toBe("");
    expect(paragraphBreak("Next.", "start")).toBe("\n\n");
    expect(paragraphBreak("\nNext.", "start")).toBe("\n");
    expect(paragraphBreak("\n\nNext.", "start")).toBe("");
  });
});

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
      {
        kind: "list",
        ordered: false,
        items: [
          { text: "scout early", children: [] },
          { text: "expand second", children: [] },
        ],
      },
      {
        kind: "list",
        ordered: true,
        items: [
          { text: "first", children: [] },
          { text: "second", children: [] },
        ],
      },
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

  it("keeps a fourth level, which the wiki's guides use under their third", () => {
    expect(parseBlocks("#### Mass")).toEqual([{ kind: "heading", level: 4, text: "Mass" }]);
  });

  it("flattens anything deeper than four", () => {
    for (const source of ["##### Five", "###### Six"]) {
      expect(parseBlocks(source)).toEqual([
        { kind: "heading", level: 4, text: source.replace(/^#+ /, "") },
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
      expect(spans.map((span) => ("text" in span ? span.text : "")).join("")).toBe(`[click](${bad})`);
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

describe("nested lists", () => {
  it("puts an indented item under the item above it", () => {
    const source = ["- opening", "  - four mexes", "  - land factory", "- mid game"].join("\n");
    expect(parseBlocks(source)).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          {
            text: "opening",
            children: [
              {
                kind: "list",
                ordered: false,
                items: [
                  { text: "four mexes", children: [] },
                  { text: "land factory", children: [] },
                ],
              },
            ],
          },
          { text: "mid game", children: [] },
        ],
      },
    ]);
  });

  it("nests a bullet list under a numbered item, and three levels deep", () => {
    const source = ["1. eco", "   - mex", "     - storage", "2. army"].join("\n");
    const [list] = parseBlocks(source);
    expect(list).toMatchObject({ kind: "list", ordered: true });
    if (list.kind !== "list") throw new Error("expected a list");
    expect(list.items.map((item) => item.text)).toEqual(["eco", "army"]);
    const inner = list.items[0].children[0];
    expect(inner).toMatchObject({ ordered: false, items: [{ text: "mex" }] });
    expect(inner.items[0].children[0].items[0].text).toBe("storage");
  });

  it("reads a tab as indentation", () => {
    const [list] = parseBlocks("- a\n\t- b");
    if (list.kind !== "list") throw new Error("expected a list");
    expect(list.items).toHaveLength(1);
    expect(list.items[0].children[0].items[0].text).toBe("b");
  });

  it("starts a new list when bullets turn into numbers at the same depth", () => {
    expect(parseBlocks("- a\n1. b").map((block) => block.kind)).toEqual(["list", "list"]);
  });
});

describe("tables", () => {
  it("reads a GFM table with alignment, padding short rows and cutting long ones", () => {
    const source = [
      "| Unit | Mass | Time |",
      "| :--- | ---: | :--: |",
      "| Engineer | 52 | 0:20 |",
      "| Mex | 36 |",
      "| Pgen | 75 | 0:15 | extra |",
    ].join("\n");
    expect(parseBlocks(source)).toEqual([
      {
        kind: "table",
        align: ["left", "right", "center"],
        header: ["Unit", "Mass", "Time"],
        rows: [
          ["Engineer", "52", "0:20"],
          ["Mex", "36", ""],
          ["Pgen", "75", "0:15"],
        ],
      },
    ]);
  });

  it("accepts a table without the outer pipes, and ends it at a blank line", () => {
    const blocks = parseBlocks("a | b\n--- | ---\n1 | 2\n\nafter");
    expect(blocks[0]).toEqual({
      kind: "table",
      align: [null, null],
      header: ["a", "b"],
      rows: [["1", "2"]],
    });
    expect(blocks[1]).toEqual({ kind: "paragraph", text: "after" });
  });

  it("does not mistake a line with a pipe for a table without a delimiter row", () => {
    expect(parseBlocks("left | right\nmore text")).toEqual([
      { kind: "paragraph", text: "left | right more text" },
    ]);
  });

  it("keeps an escaped pipe inside a cell", () => {
    expect(tableCells("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });
});

describe("images", () => {
  it("keeps an image whose address is ordinary HTTPS, with its alt text", () => {
    expect(parseSpans("![The opening](https://example.com/bo.png)")).toEqual([
      { kind: "image", text: "The opening", src: "https://example.com/bo.png" },
    ]);
  });

  it("shows an image it will not fetch as the text that was typed", () => {
    for (const bad of ["http://example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA"]) {
      const spans = parseSpans(`![x](${bad})`);
      expect(spans.every((span) => span.kind !== "image")).toBe(true);
      expect(spans.map((span) => ("text" in span ? span.text : "")).join("")).toBe(`![x](${bad})`);
    }
  });

  it("keeps the alignment of the wiki's attribute block and never shows the block", () => {
    expect(parseSpans("![Engineers](https://example.com/e.jpg){.align-right}")).toEqual([
      { kind: "image", text: "Engineers", src: "https://example.com/e.jpg", align: "right" },
    ]);
    expect(parseSpans("![](https://example.com/e.jpg){.radius-4 .shadow}")).toEqual([
      { kind: "image", text: "", src: "https://example.com/e.jpg" },
    ]);
  });
});

describe("underscores inside words", () => {
  it("does not italicise snake_case", () => {
    expect(parseSpans("set unit_cap_max now")).toEqual([
      { kind: "text", text: "set unit_cap_max now" },
    ]);
  });

  it("does not embolden double underscores inside a word", () => {
    expect(parseSpans("foo__bar__baz")).toEqual([{ kind: "text", text: "foo__bar__baz" }]);
  });

  it("still reads underscore emphasis that stands on its own", () => {
    expect(parseSpans("an _italic_ word, a __bold__ one, (_paren_)")).toEqual([
      { kind: "text", text: "an " },
      { kind: "em", text: "italic" },
      { kind: "text", text: " word, a " },
      { kind: "strong", text: "bold" },
      { kind: "text", text: " one, (" },
      { kind: "em", text: "paren" },
      { kind: "text", text: ")" },
    ]);
  });

  it("keeps asterisk emphasis working inside a word", () => {
    expect(parseSpans("un*frigging*believable")).toEqual([
      { kind: "text", text: "un" },
      { kind: "em", text: "frigging" },
      { kind: "text", text: "believable" },
    ]);
  });
});

describe("what the wiki's guides write in HTML", () => {
  it("breaks a line on <br>, however it is spelled", () => {
    for (const tag of ["<br>", "<br/>", "<br />", "</br>"]) {
      expect(parseSpans(`one${tag}two`)).toEqual([
        { kind: "text", text: "one" },
        { kind: "break" },
        { kind: "text", text: "two" },
      ]);
    }
  });

  it("reads an <img> tag as a picture, and a glyph-sized one as an icon", () => {
    expect(parseSpans('<img src="https://example.com/mass.png" width="20"/> Mass')).toEqual([
      { kind: "image", text: "", src: "https://example.com/mass.png", icon: true },
      { kind: "text", text: " Mass" },
    ]);
    expect(parseSpans('<img src="https://example.com/big.jpg" width="1000"/>')).toEqual([
      { kind: "image", text: "", src: "https://example.com/big.jpg", icon: false },
    ]);
  });

  it("leaves an <img> it will not fetch as the text that was typed", () => {
    const tag = '<img src="javascript:alert(1)">';
    expect(parseSpans(tag)).toEqual([{ kind: "text", text: tag }]);
  });
});

describe("relative addresses", () => {
  const base = "https://wiki.faforever.com/Play/Learning-SupCom/Beginners-Guide";

  it("resolve against the page the guide came from", () => {
    expect(resolveAddress("/Play/Windows-Install", base)).toBe(
      "https://wiki.faforever.com/Play/Windows-Install",
    );
    expect(parseSpans("[Windows](/Play/Windows-Install)", base)).toEqual([
      { kind: "link", text: "Windows", href: "https://wiki.faforever.com/Play/Windows-Install" },
    ]);
  });

  it("stay as typed without a base, as in the editor's preview", () => {
    expect(resolveAddress("/Play/Windows-Install")).toBeNull();
    expect(parseSpans("[Windows](/Play/Windows-Install)")).toEqual([
      { kind: "text", text: "[Windows](/Play/Windows-Install)" },
    ]);
  });

  it("never resolve to anything but HTTPS", () => {
    expect(resolveAddress("javascript:alert(1)", base)).toBeNull();
    expect(resolveAddress("http://example.com/x", base)).toBeNull();
  });
});

describe("what the copied guides carry from their old homes", () => {
  it("reads a line of dashes, stars or underscores as a rule", () => {
    for (const rule of ["---", "***", "___", "- - -"]) {
      expect(parseBlocks(`above\n\n${rule}\n\nbelow`)).toEqual([
        { kind: "paragraph", text: "above" },
        { kind: "rule" },
        { kind: "paragraph", text: "below" },
      ]);
    }
  });

  it("drops the wiki's attribute block from a heading", () => {
    expect(parseBlocks("## Early Game {#early}")).toEqual([
      { kind: "heading", level: 2, text: "Early Game" },
    ]);
  });

  it("reads a tabset heading as where tabs start, not as a title", () => {
    expect(
      parseBlocks("## Spending Resources\n## Spending Resources{.tabset}\n### Mass\n\ntext"),
    ).toEqual([
      { kind: "heading", level: 2, text: "Spending Resources" },
      { kind: "tabset", level: 2 },
      { kind: "heading", level: 3, text: "Mass" },
      { kind: "paragraph", text: "text" },
    ]);
  });

  it("reads three stars as bold and italic at once", () => {
    expect(parseSpans("***Therefore, fundamentals.***")).toEqual([
      { kind: "strong", text: "Therefore, fundamentals.", em: true },
    ]);
  });
});

describe("a link to another guide", () => {
  const base = {
    page: "https://forum.faforever.com/topic/1222/six-laws",
    document: "https://raw.githubusercontent.com/o/guides/main/guides/forum-six-laws.md",
  };

  it("resolves a relative .md beside the guide, the way GitHub reads it", () => {
    expect(resolveLink("forum-ui-mods.md", base)).toBe(
      "https://raw.githubusercontent.com/o/guides/main/guides/forum-ui-mods.md",
    );
  });

  it("still resolves any other relative link against the page the guide came from", () => {
    expect(resolveLink("/topic/1186", base)).toBe("https://forum.faforever.com/topic/1186");
  });
});

describe("keys on the keyboard", () => {
  it("reads a kbd tag as a key and nothing else as markup", () => {
    expect(parseSpans("press <kbd>Alt</kbd>+<kbd>Right click</kbd>")).toEqual([
      { kind: "text", text: "press " },
      { kind: "key", text: "Alt" },
      { kind: "text", text: "+" },
      { kind: "key", text: "Right click" },
    ]);
  });

  it("turns a selected combination into one key per part", () => {
    const result = applyAction("use alt + right click now", 4, 21, { kind: "keys" });
    expect(result.value).toBe("use <kbd>alt</kbd>+<kbd>right click</kbd> now");
    expect(result.value.slice(result.start, result.end)).toBe("<kbd>alt</kbd>+<kbd>right click</kbd>");
  });

  it("puts the caret inside an empty key when nothing is selected", () => {
    const result = applyAction("ab", 1, 1, { kind: "keys" });
    expect(result.value).toBe("a<kbd></kbd>b");
    expect(result.start).toBe(6);
  });
});

describe("numbered steps", () => {
  it("numbers every line a selection touches, in order", () => {
    const result = applyAction("intro\none\ntwo\nthree", 7, 15, { kind: "numbered" });
    expect(result.value).toBe("intro\n1. one\n2. two\n3. three");
    expect(result.end).toBe(15 + 9);
  });
});

describe("faction tabs", () => {
  it("writes a tabset with one tab per faction, in the game's order", () => {
    const blocks = parseBlocks(factionTabs("Per faction"));
    expect(blocks[0]).toEqual({ kind: "tabset", level: 2 });
    expect(blocks.slice(1).map((block) => (block.kind === "heading" ? block.text : block.kind))).toEqual([
      "UEF",
      "Aeon",
      "Cybran",
      "Seraphim",
    ]);
  });
});

describe("the picture the caret is on", () => {
  const text = "Before.\n\n![Rally point](images/rally.png){.align-right}\n\nAfter.";
  const caret = text.indexOf("Rally");

  it("is found with its caption and placement", () => {
    expect(pictureAt(text, caret)).toMatchObject({
      alt: "Rally point",
      src: "images/rally.png",
      align: "right",
    });
    expect(pictureAt(text, 2)).toBeNull();
  });

  it("takes a new caption and placement without touching the lines around it", () => {
    const picture = pictureAt(text, caret)!;
    expect(withPicture(text, picture, { alt: "The [rally] point", align: null })).toBe(
      "Before.\n\n![The rally point](images/rally.png)\n\nAfter.",
    );
    expect(withPicture(text, picture, { align: "center" })).toBe(
      "Before.\n\n![Rally point](images/rally.png){.align-center}\n\nAfter.",
    );
  });
});

describe("a cited video", () => {
  it("reads where it starts in every shape the guides use", () => {
    expect(videoStart("https://www.youtube.com/watch?v=EwwVVS5aGeA&t=917s")).toBe(917);
    expect(videoStart("https://www.youtube.com/watch?v=EwwVVS5aGeA&t=917")).toBe(917);
    expect(videoStart("https://youtu.be/EwwVVS5aGeA?t=1h01m7s")).toBe(3667);
    expect(videoStart("https://youtu.be/EwwVVS5aGeA?t=21m00")).toBe(1260);
    expect(videoStart("https://youtu.be/EwwVVS5aGeA")).toBe(0);
    expect(clock(917)).toBe("15:17");
    expect(clock(3667)).toBe("1:01:07");
  });

  it("is a paragraph that is nothing but a link to one, or its bare address", () => {
    const href = "https://www.youtube.com/watch?v=EwwVVS5aGeA&t=917s";
    expect(soleVideo(`[Zock's lesson at 15:17](${href})`)).toEqual({ href, label: "Zock's lesson at 15:17" });
    expect(soleVideo(href)).toEqual({ href, label: "" });
    expect(soleVideo(`See [this](${href}) for more.`)).toBeNull();
    expect(soleVideo("[a page](https://example.com/page)")).toBeNull();
  });
});
