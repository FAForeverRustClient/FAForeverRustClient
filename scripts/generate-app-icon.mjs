// Renders the repository's one piece of brand artwork into the native icon.
//
// `ui/public/assets/faflogo.svg` is the source of truth: the webview masks it
// per theme (ui/src/design-system/BrandMark.tsx) and this script rasterises the
// same file into `app-icon.png`, which `tauri icon` then fans out across
// src-tauri/icons. Regenerate with `pnpm icons` whenever the SVG changes, so the
// window, the taskbar and the installer cannot drift apart again.
//
// The wordmark is white on transparency and roughly 2:1, so it is inset in a
// square canvas rather than stretched to fill one.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "ui/public/assets/faflogo.svg");
const target = resolve(root, "app-icon.png");

const CANVAS = 1024;
const MARK_WIDTH = 880; // ~7% breathing room on the long axis.

if (!existsSync(source)) {
  console.error(`Brand artwork is missing: ${source}`);
  process.exit(1);
}

function run(command, args) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
}

// ImageMagick 7 renamed the entry point; accept either, and say so plainly when
// neither is installed rather than failing inside the render.
const magick = ["magick", "convert"].find((candidate) => {
  try {
    run(candidate, ["-version"]);
    return true;
  } catch {
    return false;
  }
});

if (!magick) {
  console.error(`
Generating the app icon needs ImageMagick (with the librsvg delegate) on PATH.

  Windows:  winget install ImageMagick.ImageMagick
  macOS:    brew install imagemagick librsvg
  Linux:    apt install imagemagick librsvg2-bin

The checked-in icons stay valid without it; this script is only needed when
ui/public/assets/faflogo.svg changes.
`);
  process.exit(1);
}

run(magick, [
  "-background", "none",
  "-density", "600",
  source,
  "-resize", `${MARK_WIDTH}x`,
  "-background", "none",
  "-gravity", "center",
  "-extent", `${CANVAS}x${CANVAS}`,
  "-depth", "8",
  `PNG32:${target}`,
]);

console.log(`Wrote ${CANVAS}x${CANVAS} app-icon.png from faflogo.svg.`);
console.log("Now fan it out across the native icon set:  pnpm tauri icon ./app-icon.png");
