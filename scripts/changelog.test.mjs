import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { combineSnippets, parseSnippetName, snippetNamesAddedSince, SNIPPET_DIR, verifyReleaseSnippets, verifySnippets } from "./changelog.mjs";

const headlines = (count = 3) => Array.from({ length: count }, (_, index) => `- Player-facing change ${index + 1}.`).join("\n");
const summary = { name: "highlights.12.md", text: headlines() };

function withFixture(run) {
  const root = resolve(tmpdir());
  const prefix = "faf-release-highlights-";
  const cwd = resolve(mkdtempSync(join(root, prefix)));
  if (dirname(cwd) !== root || !basename(cwd).startsWith(prefix)) throw new Error("Unexpected fixture cleanup path");
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("parseSnippetName", () => {
  it("reads the category and the pull request", () => {
    expect(parseSnippetName("fix.505.md")).toEqual({ category: "fix", pr: 505 });
    expect(parseSnippetName("features.7.md")).toEqual({ category: "features", pr: 7 });
    expect(parseSnippetName("highlights.530.md")).toEqual({ category: "highlights", pr: 530 });
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

  it.each([3, 5, 7])("accepts %i highlights with blank lines and Windows line endings", (count) => {
    expect(verifySnippets([{ ...summary, text: `\r\n${headlines(count).replaceAll("\n", "\r\n\r\n")}\r\n` }])).toEqual([]);
  });

  it.each([1, 2, 8])("rejects %i highlights", (count) => {
    expect(verifySnippets([{ ...summary, text: headlines(count) }])).toContain("highlights.12.md: highlights must contain 3 to 7 bullet points");
  });

  it("rejects prose, headings, nested bullets and wrapped highlight lines", () => {
    for (const line of ["A prose introduction", "### Highlights", "  - A nested bullet", "a continuation line"]) {
      expect(verifySnippets([{ ...summary, text: `- First change\n${line}\n- Last change` }])).toContain("highlights.12.md: write each highlight as one top-level '- ' bullet on one line");
    }
  });
});

describe("release highlights", () => {
  it("refuses missing, empty and duplicate summaries", () => {
    expect(verifyReleaseSnippets([])).toEqual([expect.stringContaining("found 0")]);
    expect(verifyReleaseSnippets([{ name: "features.3.md", text: "- A feature." }])).toEqual([expect.stringContaining("found 0")]);
    expect(verifyReleaseSnippets([{ ...summary, text: "" }])).toContain("highlights.12.md: empty");
    expect(verifyReleaseSnippets([summary, { ...summary, name: "highlights.13.md" }])).toEqual([expect.stringContaining("found 2")]);
    expect(verifyReleaseSnippets([summary, { name: "fix.4.md", text: "- A fix." }])).toEqual([]);
  });

  it("counts only highlights added since the previous release, using the real Git diff", () => withFixture((cwd) => {
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--quiet");
    const blob = git("hash-object", "-w", "--stdin");
    const tree = (names) => {
      git("read-tree", "--empty");
      execFileSync("git", ["update-index", "-z", "--index-info"], {
        cwd, input: names.map((name) => `100644 ${blob}\t${SNIPPET_DIR}/${name}\0`).join(""), stdio: ["pipe", "pipe", "pipe"],
      });
      return git("write-tree");
    };
    // Tree objects exercise release ranges without creating commits.
    const base = tree(["highlights.1.md", "fix.2.md"]);
    const missing = tree(["highlights.1.md", "fix.2.md", "features.3.md"]);
    const names = snippetNamesAddedSince(base, missing, cwd);
    expect(names).toEqual(["features.3.md"]);
    expect(verifyReleaseSnippets(names.map((name) => ({ name, text: "- A feature." })))).toEqual([expect.stringContaining("found 0")]);
    const ready = tree(["highlights.1.md", "fix.2.md", "features.3.md", "highlights.4.md"]);
    const selected = snippetNamesAddedSince(base, ready, cwd);
    expect(selected).toEqual(["features.3.md", "highlights.4.md"]);
    expect(verifyReleaseSnippets(selected.map((name) => ({ name, text: name.startsWith("highlights.") ? headlines() : "- A feature." })))).toEqual([]);
  }));

  it("exits before writing notes when highlights are missing, and prints them first once supplied", () => withFixture((cwd) => {
    const directory = join(cwd, SNIPPET_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "features.3.md"), "- A feature.\n");
    const run = (command) => spawnSync(process.execPath, [fileURLToPath(new URL("./changelog.mjs", import.meta.url)), command], { cwd, encoding: "utf8" });
    const missing = run("release");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("Expected exactly one new highlights.<pr>.md");
    expect(run("combine").status).toBe(0);
    writeFileSync(join(directory, summary.name), summary.text);
    const ready = run("release");
    expect(ready.status).toBe(0);
    expect(ready.stderr).toBe("");
    expect(ready.stdout).toBe(`### Highlights\n\n${headlines()}\n\n### Features\n\n- A feature.\n`);
    writeFileSync(join(directory, summary.name), headlines(2));
    expect(run("verify").status).toBe(1);
    expect(run("release").stdout).toBe("");
  }));
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

  it("leads with the highlights, and leaves the heading out when there are none", () => {
    const highlighted = combineSnippets([
      { name: "features.3.md", text: "- feature\n" },
      { name: "highlights.12.md", text: "- the headline\n- the other headline\n" },
      { name: "fix.4.md", text: "- fix\n" },
    ]);
    // "Highlights" is the heading the client's What's new window looks for.
    expect(highlighted).toBe(
      [
        "### Highlights",
        "",
        "- the headline",
        "- the other headline",
        "",
        "### Features",
        "",
        "- feature",
        "",
        "### Bug fixes",
        "",
        "- fix",
      ].join("\n")
    );

    const plain = combineSnippets([{ name: "features.3.md", text: "- feature\n" }]);
    expect(plain).toBe(["### Features", "", "- feature"].join("\n"));
  });

  it("is empty when there is nothing to say", () => {
    expect(combineSnippets([])).toBe("");
    expect(combineSnippets([{ name: ".gitkeep", text: "" }])).toBe("");
  });
});
