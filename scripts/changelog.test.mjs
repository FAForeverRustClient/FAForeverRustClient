import { describe, expect, it } from "vitest";
import { combineSnippets, parseSnippetName, verifySnippets } from "./changelog.mjs";

describe("parseSnippetName", () => {
  it("reads the category and the pull request", () => {
    expect(parseSnippetName("fix.505.md")).toEqual({ category: "fix", pr: 505 });
    expect(parseSnippetName("features.7.md")).toEqual({ category: "features", pr: 7 });
  });

  it("refuses anything else", () => {
    expect(parseSnippetName("feature.505.md")).toBeNull();
    expect(parseSnippetName("fix.links-tab.md")).toBeNull();
    expect(parseSnippetName("fix.505.txt")).toBeNull();
    expect(parseSnippetName("fix.505.md.bak")).toBeNull();
    expect(parseSnippetName("README.md")).toBeNull();
  });
});

describe("verifySnippets", () => {
  it("accepts well named snippets and skips dotfiles", () => {
    expect(
      verifySnippets([
        { name: "fix.1.md", text: "- a\n" },
        { name: ".gitkeep", text: "" },
      ])
    ).toEqual([]);
  });

  it("names a misnamed and an empty snippet", () => {
    const problems = verifySnippets([
      { name: "bugfix.1.md", text: "- a" },
      { name: "fix.2.md", text: "  \n" },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^bugfix\.1\.md:/);
    expect(problems[1]).toBe("fix.2.md: empty");
  });
});

describe("combineSnippets", () => {
  it("groups by category in release order and sorts by pull request", () => {
    const notes = combineSnippets([
      { name: "other.9.md", text: "- other\n" },
      { name: "fix.20.md", text: "- second fix\n" },
      { name: "features.3.md", text: "- feature\n" },
      { name: "fix.4.md", text: "- first fix\n" },
    ]);
    expect(notes).toBe(
      [
        "### Features",
        "",
        "- feature",
        "",
        "### Bug fixes",
        "",
        "- first fix",
        "- second fix",
        "",
        "### Other changes",
        "",
        "- other",
      ].join("\n")
    );
  });

  it("is empty when there is nothing to say", () => {
    expect(combineSnippets([])).toBe("");
    expect(combineSnippets([{ name: ".gitkeep", text: "" }])).toBe("");
  });
});
