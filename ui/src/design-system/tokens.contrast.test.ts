// The colour pairs every theme prints text in, held to WCAG's 4.5:1 for
// normal text.
//
// A theme is a block of overrides on `:root`, so a pair that clears it in the
// default theme can fail in another one that changed only one side. That is how
// the Java and Python themes came to put white labels on accents that gave
// them 2.9 and 3.1:1, and how the faction colours, printed as faction names,
// fell to 2.0 to 3.5:1 on the light theme's white and 2.8:1 on the other dark
// themes' lighter surfaces. Read from the stylesheet itself, so a new theme or
// a changed token is checked without anyone remembering to add it here.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");

/** Every theme's tokens, each resolved over `:root`'s. */
function themes(): Map<string, Record<string, string>> {
  const blocks = new Map<string, Record<string, string>>();
  for (const block of css.matchAll(/(:root|\[data-theme='(\w+)'\])\s*\{([^}]*)\}/g)) {
    const name = block[2] ?? "default";
    const tokens = blocks.get(name) ?? {};
    for (const token of block[3].matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[token[1]] = token[2].trim();
    blocks.set(name, tokens);
  }
  const root = blocks.get("default") ?? {};
  return new Map([...blocks].map(([name, tokens]) => [name, { ...root, ...tokens }]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const HEX = /^#[0-9a-f]{6}$/i;
const FACTIONS = ["uef", "aeon", "cybran", "seraphim"] as const;
const STATUSES = ["ok", "warn", "error"] as const;

describe("theme colour contrast", () => {
  const all = themes();

  it("finds every theme", () => {
    expect([...all.keys()]).toEqual(expect.arrayContaining(["default", "forgeLight", "javaClient", "pythonClient"]));
  });

  for (const [name, tokens] of all) {
    it(`${name}: a label on the accent is legible`, () => {
      const [label, fill] = [tokens["color-accent-contrast"], tokens["color-accent"]];
      expect(label).toMatch(HEX);
      expect(fill).toMatch(HEX);
      expect(contrast(label, fill)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: faction names are legible on every surface`, () => {
      for (const surface of ["color-surface", "color-surface-raised"]) {
        for (const faction of FACTIONS) {
          const colour = tokens[`color-faction-${faction}`];
          expect(colour, `${faction} in ${name}`).toMatch(HEX);
          expect(
            contrast(colour, tokens[surface]),
            `${faction} on ${surface} in ${name}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    // The captions under headings and the metadata beside names. The Java and
    // Python themes printed them at 2.1 to 3.8:1 on their raised surfaces.
    it(`${name}: secondary text is legible on every surface`, () => {
      for (const surface of ["color-surface", "color-surface-raised", "color-bg"]) {
        for (const level of ["color-muted", "color-subtle"]) {
          const colour = tokens[level];
          expect(colour, `${level} in ${name}`).toMatch(HEX);
          expect(
            contrast(colour, tokens[surface]),
            `${level} on ${surface} in ${name}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    // Victory and Defeat, a warning's word, an error's line: small text in a
    // status colour. They read 2.4 to 4.1:1 in the light, Java and Python
    // themes while only the accent and the factions were checked.
    it(`${name}: status text is legible on every surface`, () => {
      for (const surface of ["color-surface", "color-surface-raised", "color-bg"]) {
        for (const status of STATUSES) {
          const colour = tokens[`color-${status}-text`];
          expect(colour, `${status} text in ${name}`).toMatch(HEX);
          expect(
            contrast(colour, tokens[surface]),
            `${status} text on ${surface} in ${name}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }
});

/** Every stylesheet under `ui/src`, by path. */
function stylesheets(): Map<string, string> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".css")) found.set(path, readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return found;
}

describe("status colours as text", () => {
  // The status colours stay what they were as fills and outlines, and some of
  // them are too dark or too light to read as small text on their own theme's
  // surfaces. So text takes the `-text` token, and this keeps it that way.
  it("print text through the text tokens, never the fill colours", () => {
    const offenders: string[] = [];
    for (const [path, source] of stylesheets()) {
      if (path.split("\\").join("/").endsWith("design-system/tokens.css")) continue;
      for (const match of source.matchAll(/(?:^|[^-\w])color:\s*var\(--color-(ok|error|warn)\)/g)) {
        offenders.push(`${path}: ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
