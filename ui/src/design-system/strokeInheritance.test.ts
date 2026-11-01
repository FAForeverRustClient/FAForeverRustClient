// A dash pattern is an inherited property. Set on an HTML element, it reaches
// every SVG inside it, and the icons, which set their own stroke colour and
// width but no dash, are drawn dashed. That happened to every matchmaker queue
// card: the rating graph's dashed guide line shared its class name with the
// grid holding the cards. Dashes belong on SVG shapes, never on a class that
// any ordinary element also carries.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DASHES = /\bstroke-dash(?:array|offset)\s*:/;
// Elements a dash pattern is meant for, or that only hold SVG drawing.
const SVG_ELEMENTS = new Set(["svg", "g", "line", "path", "circle", "ellipse", "rect", "polyline", "polygon", "text", "tspan", "use"]);

function files(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, extension);
    return entry.name.endsWith(extension) && !entry.name.includes(".test.") ? [path] : [];
  });
}

/** Classes on the element a dash rule styles: the last compound of each selector. */
function dashedClasses(): Map<string, string> {
  const classes = new Map<string, string>();
  for (const file of files(SRC, ".css")) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!DASHES.test(body)) continue;
      for (const selector of selectors.split(",")) {
        const subject = selector.trim().split(/[\s>+~]+/).pop() ?? "";
        for (const [, name] of subject.matchAll(/\.([\w-]+)/g)) classes.set(name, file.slice(SRC.length));
      }
    }
  }
  return classes;
}

describe("dash patterns", () => {
  it("are only ever set on SVG shapes, so icons inside never inherit them", () => {
    const dashed = dashedClasses();
    expect(dashed.size).toBeGreaterThan(0);
    const leaks: string[] = [];
    for (const file of files(SRC, ".tsx")) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/className="([^"]+)"/g)) {
        const tag = /^<([a-z][\w-]*)/.exec(source.slice(source.lastIndexOf("<", match.index)))?.[1];
        if (tag === undefined || SVG_ELEMENTS.has(tag)) continue;
        for (const name of match[1].split(/\s+/)) {
          if (dashed.has(name)) leaks.push(`<${tag} class="${name}"> in ${file.slice(SRC.length)} (dashed in ${dashed.get(name)})`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
