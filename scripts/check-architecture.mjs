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

// Blank out every character except newlines, so offsets and line numbers in
// the result still point at the same place in the original source.
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

// Rust source with comments and string and char literals blanked out.
//
// The plain `//.*$` strip the older rules use is enough to find a path, but
// it cuts a literal such as "https://..." in half, and the test-module rule
// below has to match braces, which an unbalanced literal would throw off.
function rustCode(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    let end = -1;
    if (c === "/" && next === "/") {
      end = source.indexOf("\n", i);
      if (end === -1) end = source.length;
    } else if (c === "/" && next === "*") {
      // Rust block comments nest.
      let depth = 1;
      end = i + 2;
      while (end < source.length && depth > 0) {
        if (source.startsWith("/*", end)) { depth++; end += 2; }
        else if (source.startsWith("*/", end)) { depth--; end += 2; }
        else end++;
      }
    } else if ((c === "r" || (c === "b" && next === "r")) && !/\w/.test(source[i - 1] ?? "")) {
      const raw = /^b?r(#*)"/.exec(source.slice(i, i + 300));
      if (raw) {
        const close = `"${raw[1]}`;
        const found = source.indexOf(close, i + raw[0].length);
        end = found === -1 ? source.length : found + close.length;
      }
    } else if (c === '"') {
      end = i + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      end++;
    } else if (c === "'") {
      // A char literal, or else the quote of a lifetime, which is left alone.
      const literal = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/u.exec(source.slice(i, i + 16));
      if (literal) end = i + literal[0].length;
    }
    if (end === -1) {
      out += c;
      i++;
    } else {
      out += blank(source.slice(i, end));
      i = end;
    }
  }
  return out;
}

// `code` (from `rustCode`) with every `#[cfg(test)]` item blanked out, and the
// names of test modules that live in a file of their own (`mod tests;`).
function withoutTestItems(code) {
  let result = code;
  const externalModules = [];
  for (const match of code.matchAll(/#\[cfg\(test\)\]/g)) {
    const start = match.index;
    let i = start + match[0].length;
    while (i < code.length && code[i] !== "{" && code[i] !== ";") i++;
    if (code[i] === ";") {
      const external = /\bmod\s+(\w+)\s*$/.exec(code.slice(start, i));
      if (external) externalModules.push(external[1]);
      continue;
    }
    let depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) break;
    }
    result = result.slice(0, start) + blank(result.slice(start, i + 1)) + result.slice(i + 1);
  }
  return { code: result, externalModules };
}

// Where `mod name;` declared in `path` keeps its source, either spelling.
function moduleFiles(path, name) {
  const directory = resolve(path, "..");
  const file = path.slice(directory.length + 1);
  const base = ["mod.rs", "lib.rs", "main.rs"].includes(file)
    ? directory
    : resolve(directory, file.replace(/\.rs$/, ""));
  return [resolve(base, `${name}.rs`), resolve(base, name, "mod.rs")];
}

// Application services depend on ports and domain types, never concrete IO.
//
// Both spellings count: importing infra, and calling into it by its full path.
// Only the first was checked once, and the settings and maps services had
// grown `crate::infra::...` calls the check could not see, so a clean result
// promised a boundary that was not there. Comments are left out, so a doc link
// to an adapter is still allowed.
for (const path of await sourceFiles(resolve(root, "crates/faf-app/src/services"), new Set([".rs"]))) {
  const source = await readFile(path, "utf8");
  const code = source.replace(/\/\/.*$/gm, "");
  const match = /\bcrate::infra\b/.exec(code);
  if (match) {
    report(path, `line ${lineNumber(code, match.index)} reaches a concrete infra adapter; depend on a port instead`);
  }
  // The same boundary without the word "infra" in it: a file read or write in
  // a service is IO the ports cannot see, fake or route. The launcher read the
  // installed build's stamp this way until it moved behind the updater port.
  const fsMatch = /\b(?:std|tokio)::(?:fs\b|\{[^}]*\bfs\b)/.exec(rustCode(source));
  if (fsMatch) {
    report(path, `line ${lineNumber(source, fsMatch.index)} touches the filesystem directly; move the IO behind a port`);
  }
  // One service starting another's command goes through the command policy
  // (`runtime::run_command`), like a command from the webview. Calling the
  // other service's `handle` directly walked past it: the training tab's
  // catalogue load started a second crawl beside the Maps tab's own.
  const handleMatch = /\b(?:services|super)::\w+::handle\s*\(/.exec(rustCode(source));
  if (handleMatch) {
    report(path, `line ${lineNumber(source, handleMatch.index)} calls another service's handler directly; use crate::runtime::run_command so the command policy applies`);
  }
  // A settings group written from outside the settings service goes through
  // `ctx.settings.merge_and_emit`, which reads, changes and emits it under the
  // lock the settings commands merge under. Event reminders and chat read
  // markers emitted straight from their own earlier read, and a settings patch
  // to the same group landing in between was put back to its old value.
  const settingsEmit = /\bemit\s*\(\s*SettingsEvent::/.exec(rustCode(source));
  if (settingsEmit && !path.endsWith(`${sep}services${sep}settings.rs`)) {
    report(path, `line ${lineNumber(source, settingsEmit.index)} emits a settings event directly; go through ctx.settings.merge_and_emit so it cannot undo a concurrent settings patch`);
  }
}

// The domain crate is pure: the same state and input give the same result.
// A clock read breaks that silently, as the map generator's style picks did
// when they fell back to the current time. The caller reads the clock and
// passes the value in. Tests may read a clock, so `#[cfg(test)]` items are
// left out, including test modules kept in a file of their own.
{
  const domainFiles = await sourceFiles(resolve(root, "crates/faf-domain/src"), new Set([".rs"]));
  const cleaned = new Map();
  const testFiles = new Set();
  for (const path of domainFiles) {
    const { code, externalModules } = withoutTestItems(rustCode(await readFile(path, "utf8")));
    cleaned.set(path, code);
    for (const name of externalModules) for (const file of moduleFiles(path, name)) testFiles.add(file);
  }
  for (const [path, code] of cleaned) {
    if (testFiles.has(path)) continue;
    const match = /\b(?:SystemTime|Instant|Utc|Local)::now\b/.exec(code);
    if (match) {
      report(path, `line ${lineNumber(code, match.index)} reads the clock in the domain crate; take the time as an input instead`);
    }
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
