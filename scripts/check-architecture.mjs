import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const violations = [];
// Generated output, not source: the same reason "dist" and "target" are here.
const ignoredDirectories = new Set([
  ".agents", ".git", "context", "dist", "graphify-out", "natives", "node_modules", "target",
]);

async function sourceFiles(directory, extensions) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path, extensions));
    else if (extensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function report(path, message) {
  violations.push(`${relative(root, path).split(sep).join("/")}: ${message}`);
}

// Application services depend on ports and domain types, never concrete IO.
for (const path of await sourceFiles(resolve(root, "crates/faf-app/src/services"), new Set([".rs"]))) {
  const source = await readFile(path, "utf8");
  if (/\b(?:pub\s+)?use\s+crate::infra\b/.test(source)) {
    report(path, "service imports a concrete infra adapter; depend on a port instead");
  }
}

// Tauri APIs are a single explicit browser/native boundary. Feature modules use
// ipc/client.ts for domain commands and ipc/native.ts for scoped OS facilities.
for (const path of await sourceFiles(resolve(root, "ui/src"), new Set([".ts", ".tsx"]))) {
  const source = await readFile(path, "utf8");
  const relativePath = relative(resolve(root, "ui/src"), path);
  const insideIpc = relativePath === "ipc" || relativePath.startsWith(`ipc${sep}`);
  if (!insideIpc && /from\s+["']@tauri-apps\//.test(source)) {
    report(path, "imports Tauri directly; add the capability to ui/src/ipc instead");
  }
  if (/\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined|\[\])/.test(source)
      || /new\s+Intl\.(?:DateTimeFormat|NumberFormat)\(\s*(?:\)|undefined)/.test(source)) {
    report(path, "inherits the operating-system locale; keep formatting explicitly English until localization exists");
  }
}

// Foundation code must stay reusable and must not reach upward into a feature.
for (const directory of ["design-system", "i18n", "ipc", "shared", "store"]) {
  for (const path of await sourceFiles(resolve(root, "ui/src", directory), new Set([".ts", ".tsx"]))) {
    const source = await readFile(path, "utf8");
    if (/from\s+["'][^"']*features\//.test(source)) {
      report(path, `${directory} imports feature code; move the shared contract downward`);
    }
  }
}

// A feature folder is a module: it may depend on the foundation directories
// above and on nothing beside it. Anything two features both need belongs in
// `shared/`, which is where the player menu, the map preview, the join flow
// and the rest went when this rule was written; before it, thirty-seven
// feature-to-feature edges had accumulated, four of them cycles.
//
// The shell and the tab registry are the composition roots and import every
// tab by design. The remaining edges are listed here, each with the reason
// it is a real dependency rather than a helper that has not moved yet. Add to
// this list only with such a reason; the aim is for it to shrink.
const compositionRoots = new Set(["shell", "nav"]);
const allowedFeatureEdges = new Map([
  // The host dialog embeds the map generator and the map uninstall dialog.
  ["lobby -> maps", "hosting a game embeds the maps feature's generator and dialogs"],
  // The matchmaker's party chat is the chat feature's composer and message list.
  ["lobby -> chat", "the party chat panel is the chat feature embedded in the matchmaker"],
  // Uploading is its own feature with its own state slice; the vaults open it.
  ["maps -> uploads", "the map vault opens the uploads feature's dialog"],
  ["mods -> uploads", "the mod vault opens the uploads feature's dialog"],
  // A notification can deep-link to the settings section that governs it,
  // and the settings section can preview the notification's sound.
  ["notifications -> settings", "a notification links to its settings section"],
  ["settings -> notifications", "the notifications section previews the sounds"],
  ["notifications -> chat", "a chat notification renders with chat's message formatter"],
  // The start-tab setting lists the tabs, which only the registry knows.
  ["settings -> nav", "the start-tab setting reads the tab registry"],
]);
const featuresRoot = resolve(root, "ui/src/features");
for (const path of await sourceFiles(featuresRoot, new Set([".ts", ".tsx"]))) {
  if (/\.test\.tsx?$/.test(path)) continue;
  const from = relative(featuresRoot, path).split(sep)[0];
  if (compositionRoots.has(from)) continue;
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
    const target = relative(featuresRoot, resolve(path, "..", match[1]));
    if (target.startsWith("..")) continue; // outside features/: foundation code
    const to = target.split(sep)[0];
    if (to === from) continue;
    const edge = `${from} -> ${to}`;
    if (!allowedFeatureEdges.has(edge)) {
      report(path, `line ${lineNumber(source, match.index)} imports from features/${to}; move what both need into ui/src/shared, or list "${edge}" with its reason in check-architecture.mjs`);
    }
  }
}

// Compact metadata still has to remain readable on an ordinary desktop
// display. This was previously documented but unenforced, which allowed more
// than forty sub-floor declarations to accumulate again.
for (const path of await sourceFiles(resolve(root, "ui/src"), new Set([".css"]))) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)) {
    if (Number(match[1]) < 11) {
      report(path, `line ${lineNumber(source, match.index)} sets font-size below the 11 px floor`);
    }
  }
}

// Repository prose is user-facing too. Keep the no-em-dash rule executable so
// generated UI copy and documentation cannot silently reintroduce it.
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".rs", ".ts", ".tsx"]);
for (const path of await sourceFiles(root, textExtensions)) {
  const source = await readFile(path, "utf8");
  const index = source.indexOf("\u2014");
  if (index !== -1) {
    report(path, `line ${lineNumber(source, index)} contains an em dash`);
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary violations:\n");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Architecture boundaries are clean.");
