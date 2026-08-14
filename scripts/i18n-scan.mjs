// Reports user-facing text that has not been routed through the i18n catalogue.
//
// Localisation is being rolled out feature by feature (see ui/src/i18n/). This
// script is how that rollout stays measurable: it prints every literal string
// that still looks like copy, grouped by file, plus a total.
//
// It is a heuristic, deliberately biased towards over-reporting. A false
// positive costs one glance; a missed string ships an untranslatable client.
// Two hiding places matter most and are both covered here, because an earlier
// version that only looked at JSX text nodes under-reported by roughly half:
//
//   {copied ? "Link copied" : "Copy live link"}     ternaries
//   case "VICTORY": return "Victory";               switch returns
//
// Usage:
//   node scripts/i18n-scan.mjs                 whole ui/src, counts per file
//   node scripts/i18n-scan.mjs ui/src/features/maps --list    with the strings
//   node scripts/i18n-scan.mjs --max 0         exit non-zero above a budget

import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const verbose = args.includes("--list");
const maxIndex = args.indexOf("--max");
const budget = maxIndex === -1 ? null : Number(args[maxIndex + 1]);
const target = args.find((arg) => !arg.startsWith("--") && arg !== String(budget)) ?? "ui/src";

// Files whose capitalised strings are data, not copy. Each carries its reason:
// an unexplained ignore list is how real strings get lost.
const IGNORED_FILES = new Map([
  ["ui/src/store/reducer.ts", "AppEvent kind discriminants, matched against the wire"],
  ["ui/src/store/store.ts", "string-concatenation fragments, not standalone copy"],
  ["ui/src/shared/mapPresentation.ts", "official map names: proper nouns, never translated"],
  ["ui/src/design-system/Icon.tsx", "inline SVG path data"],
  ["ui/src/shared/externalLinks.ts", "developer-facing throw messages, never rendered"],
  ["ui/src/shared/factions.ts", "faction data keyed by wire id; the shown label is factions.random"],
]);

// Attribute names whose values are machine tokens, never prose.
const TECHNICAL_ATTRS =
  /\b(?:className|key|id|htmlFor|name|type|role|value|href|src|rel|target|autoComplete|inputMode|data-[\w-]+|aria-(?:hidden|current|expanded|haspopup|controls|live|valuetext|labelledby|describedby|selected|checked|disabled|sort))\s*=\s*"[^"]*"/g;

// Object keys carrying machine tokens in this codebase's command shapes.
const COMMAND_KEYS =
  /\b(?:kind|type|command|payload|leaderboard|sortBy|field|constraint|faction|outcome|status|mode|tab|channel|queueName|folderName|technicalName)\s*:\s*"[^"]*"/g;

// KeyboardEvent.key values: compared against, never displayed, and sentence
// cased, so without this list they dominate the report.
const KEYBOARD_KEYS = new Set([
  "Enter", "Escape", "Backspace", "Delete", "Tab", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Shift", "Control", "Alt", "Meta",
]);

// TypeScript builtins that appear as bare words in type positions.
const TYPE_NAMES = new Set([
  "Promise", "Record", "Partial", "Readonly", "Array", "Map", "Set", "ReactNode", "JSX",
]);

const NOT_PROSE = [
  /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/,          // kebab/snake/lower identifiers
  /^[A-Z][A-Z0-9_]*$/,                            // SCREAMING_CASE
  /^[\w.-]+\.(?:tsx?|css|json|lua|exe|jar|png|svg)$/i,
  /^#[0-9a-f]{3,8}$/i,                            // colours
  /^\d/,                                          // starts with a digit
  /^[^a-zA-Z]*$/,                                 // no letters at all
  /^(?:faf|coop|nomads|fafbeta|fafdevelop|ladder1v1|global|en|de|UEF|Aeon|Cybran|Seraphim)$/,
  /^[a-z][\w-]*(?:\s+[a-z][\w-]*)+$/,             // a CSS class list
  /(?:\|\||&&|===|!==|=>|\)\.)/,                  // half of a split expression
  /^[A-Z][a-z]+(?:[A-Z][a-z]+)+$/,                // PascalCase type or slice name
  /^[,;:.]/,                                      // half of a concatenation
  /^\)/,                                          // starts mid-expression
  /[<>{}]/,                                       // contains markup or a brace
];

function isProse(value) {
  const text = value.trim();
  if (text.length < 3) return false;
  if (KEYBOARD_KEYS.has(text)) return false;
  if (TYPE_NAMES.has(text)) return false;
  if (NOT_PROSE.some((rule) => rule.test(text))) return false;
  if (!/[a-z]/.test(text)) return false;
  // Either a sentence-cased word or several words: both read as copy.
  return /^[A-Z][a-z]/.test(text) || /\s[a-z]/.test(text);
}

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "i18n"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if ([".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.includes(".test."))
      found.push(path);
  }
  return found;
}

let total = 0;
const perFile = [];

for (const path of (await sourceFiles(resolve(root, target))).sort()) {
  const relativePath = relative(root, path).split("\\").join("/");
  if (IGNORED_FILES.has(relativePath)) continue;

  const source = (await readFile(path, "utf8"))
    .replace(/^\s*import[^;]+;$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\bt\(\s*"[^"]*"/g, "t(")
    .replace(/\bMessageKey\b[^;]*;/g, "")
    .replace(TECHNICAL_ATTRS, "")
    .replace(COMMAND_KEYS, "");

  const hits = new Set();
  for (const [, value] of source.matchAll(/"([^"\\\n]{3,})"/g)) if (isProse(value)) hits.add(value);
  for (const [, value] of source.matchAll(/'([^'\\\n]{3,})'/g)) if (isProse(value)) hits.add(value);
  // JSX text nodes are not string literals, so they need their own pass.
  for (const [, value] of source.matchAll(/>\s*([A-Z][A-Za-z0-9 ,.'\u2019!?()/&%:-]{2,})\s*</g)) {
    if (isProse(value)) hits.add(value);
  }

  if (hits.size === 0) continue;
  total += hits.size;
  perFile.push([relativePath, [...hits]]);
}

perFile.sort((left, right) => right[1].length - left[1].length);
for (const [file, hits] of perFile) {
  console.log(`${String(hits.length).padStart(4)}  ${file}`);
  if (verbose) for (const hit of hits) console.log(`        ${hit}`);
}

console.log(`\nUntranslated strings: ${total}`);

if (budget !== null && total > budget) {
  console.error(`\nBudget exceeded: ${total} > ${budget}`);
  process.exit(1);
}
