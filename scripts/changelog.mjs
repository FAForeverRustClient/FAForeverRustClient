// Changelog snippets: one small file per pull request, combined at release.
//
// This is how FAForever/fa keeps its patch notes (`changelog/snippets`), and
// for the same reason: a single CHANGELOG.md that every pull request appends
// to conflicts with every other pull request open at the same time. A file of
// its own, named after the pull request, never does.
//
// A snippet is `changelog/snippets/<category>.<pr>.md`, holding one short line
// for players: `- Replays can be filtered by map`. See `changelog/README.md`.
//
// Usage:
//   node scripts/changelog.mjs verify            every snippet is well named
//   node scripts/changelog.mjs combine [<tag>]   the release notes, to stdout
//
// `combine` with a tag takes only the snippets added since that tag, which is
// what the Release workflow passes: the previous release. So snippets never
// have to be deleted for the next release to start empty, and deleting old
// ones later is harmless.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const SNIPPET_DIR = "changelog/snippets";

/** File name prefix and the heading it is listed under, in release order. */
export const CATEGORIES = [
  ["features", "Features"],
  ["fix", "Bug fixes"],
  ["performance", "Performance"],
  ["other", "Other changes"],
];

const NAME = new RegExp(
  `^(${CATEGORIES.map(([prefix]) => prefix).join("|")})\\.([0-9]{1,5})\\.md$`
);

/** `fix.505.md` -> `{ category: "fix", pr: 505 }`, anything else -> null. */
export function parseSnippetName(name) {
  const match = NAME.exec(name);
  return match ? { category: match[1], pr: Number(match[2]) } : null;
}

/**
 * Every problem with a set of snippets, as messages. Dotfiles (`.gitkeep`)
 * are not snippets and are skipped.
 *
 * @param {{ name: string, text: string }[]} snippets
 */
export function verifySnippets(snippets) {
  const problems = [];
  for (const { name, text } of snippets) {
    if (name.startsWith(".")) continue;
    if (!parseSnippetName(name)) {
      const prefixes = CATEGORIES.map(([prefix]) => prefix).join(", ");
      problems.push(`${name}: not <category>.<pr>.md, with category one of ${prefixes}`);
    } else if (!text.trim()) {
      problems.push(`${name}: empty`);
    }
  }
  return problems;
}

/**
 * The release notes: one heading per category that has snippets, the
 * snippets under it in pull request order. Empty when there are none.
 *
 * @param {{ name: string, text: string }[]} snippets
 */
export function combineSnippets(snippets) {
  const parsed = snippets
    .map((snippet) => ({ ...snippet, ...parseSnippetName(snippet.name) }))
    .filter((snippet) => snippet.category && snippet.text.trim());

  const sections = [];
  for (const [category, heading] of CATEGORIES) {
    const lines = parsed
      .filter((snippet) => snippet.category === category)
      .sort((a, b) => a.pr - b.pr)
      .map((snippet) => snippet.text.trim());
    if (lines.length) sections.push(`### ${heading}\n\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

function read(names) {
  return names.map((name) => ({
    name,
    text: readFileSync(join(SNIPPET_DIR, name), "utf8"),
  }));
}

function allSnippetNames() {
  return readdirSync(SNIPPET_DIR).filter((name) => !name.startsWith("."));
}

// Compares the two trees, not the commits between them, so a pull request
// branched before the tag and merged after it still counts as new.
function snippetNamesAddedSince(tag) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=A", tag, "HEAD", "--", SNIPPET_DIR],
    { encoding: "utf8" }
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((path) => basename(path))
    .filter((name) => !name.startsWith("."));
}

function main() {
  const [command, tag] = process.argv.slice(2);

  if (command === "verify") {
    const problems = verifySnippets(read(allSnippetNames()));
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
    else console.log("Every changelog snippet is well formed.");
    return;
  }

  if (command === "combine") {
    const snippets = read(tag ? snippetNamesAddedSince(tag) : allSnippetNames());
    const problems = verifySnippets(snippets);
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      process.exitCode = 1;
      return;
    }
    const notes = combineSnippets(snippets);
    if (notes) console.log(notes);
    return;
  }

  console.error("Usage: node scripts/changelog.mjs verify | combine [<tag>]");
  process.exitCode = 1;
}

// Importable for the tests, runnable as a script. `process.argv[1]` is the
// script itself only when it was started directly.
if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  main();
}
