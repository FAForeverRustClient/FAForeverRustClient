// Reports how complete each translation catalogue is, and can emit the missing
// keys for one language as a ready-to-fill stub.
//
// Catalogues are `Partial` by design, so an incomplete language is safe: every
// missing key falls back to English. That safety is also why coverage has to be
// measured rather than assumed. Without this, "French is done" is a guess.
//
// Usage:
//   node scripts/i18n-coverage.mjs               coverage per language
//   node scripts/i18n-coverage.mjs fr --missing  the untranslated keys for fr
//   node scripts/i18n-coverage.mjs --min 100     fail below a threshold

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const catalogueDir = resolve(root, "ui/src/i18n/catalog");
const args = process.argv.slice(2);
const wantMissing = args.includes("--missing");
const minIndex = args.indexOf("--min");
const minimum = minIndex === -1 ? null : Number(args[minIndex + 1]);
const only = args.find((arg) => !arg.startsWith("--") && arg !== String(minimum));

/** Keys of a catalogue file, read as text: importing TypeScript here would need a build step. */
async function keysOf(file) {
  const source = await readFile(resolve(catalogueDir, file), "utf8");
  return new Set([...source.matchAll(/^\s+"([a-z][\w.]*)":/gm)].map((match) => match[1]));
}

const files = (await readdir(catalogueDir)).filter(
  (name) => name.endsWith(".ts") && name !== "index.ts",
);

const english = await keysOf("en.ts");
const rows = [];

for (const file of files.sort()) {
  const code = file.replace(/\.ts$/, "");
  if (code === "en") continue;
  const translated = await keysOf(file);
  const missing = [...english].filter((key) => !translated.has(key));
  const unknown = [...translated].filter((key) => !english.has(key));
  rows.push({ code, translated: english.size - missing.length, missing, unknown });
}

if (only && wantMissing) {
  const row = rows.find((candidate) => candidate.code === only);
  if (!row) {
    console.error(`No catalogue for "${only}".`);
    process.exit(1);
  }
  for (const key of row.missing) console.log(`  "${key}": "",`);
  console.error(`\n${row.missing.length} keys missing for ${only}.`);
  process.exit(0);
}

console.log(`Source (en): ${english.size} keys\n`);
let below = false;
for (const row of rows) {
  const percent = ((row.translated / english.size) * 100).toFixed(1);
  console.log(
    `${row.code.padEnd(6)} ${String(row.translated).padStart(5)}/${english.size}  ${percent.padStart(5)}%` +
      (row.unknown.length > 0 ? `  (${row.unknown.length} keys not in en)` : ""),
  );
  // A key that exists only in a translation is dead weight: nothing can render
  // it, and it usually means the English source was renamed underneath it.
  for (const key of row.unknown) console.log(`         orphan: ${key}`);
  if (minimum !== null && Number(percent) < minimum) below = true;
}

if (below) {
  console.error(`\nAt least one catalogue is below ${minimum}%.`);
  process.exit(1);
}
