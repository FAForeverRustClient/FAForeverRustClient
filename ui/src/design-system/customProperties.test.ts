// A custom property that is defined nowhere makes the declaration reading it
// invalid, and the browser says nothing: the property silently falls back to
// inherited or initial. That is how the shared Select lost its selected-option
// background and the replay dialogs their room for the close button, with
// `--color-surface-selected`, `--color-text-strong` and `--space-5`, none of
// which ever existed. Every name a stylesheet reads without a fallback must be
// declared in a stylesheet or set from a component.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : files(path, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) && !entry.name.includes(".test.") ? [path] : [];
  });
}

const stylesheets = files(SRC, [".css"]).map((path) => ({
  path: path.slice(SRC.length),
  text: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}));
const components = files(SRC, [".ts", ".tsx"]).map((path) => readFileSync(path, "utf8"));

describe("custom properties", () => {
  it("are all defined somewhere when a stylesheet reads one without a fallback", () => {
    const defined = new Set<string>();
    // Families set from code as `--prefix-${name}` define every name they start.
    const families: string[] = [];
    for (const { text } of stylesheets) for (const [, name] of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(name);
    for (const source of components) {
      for (const [, name] of source.matchAll(/["'`](--[\w-]+)["'`]/g)) defined.add(name);
      for (const [, prefix] of source.matchAll(/`(--[\w-]+-)\$\{/g)) families.push(prefix);
    }
    const missing: string[] = [];
    for (const { path, text } of stylesheets) {
      for (const [, name, fallback] of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
        if (fallback || defined.has(name) || families.some((prefix) => name.startsWith(prefix))) continue;
        missing.push(`${name} in ${path}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
