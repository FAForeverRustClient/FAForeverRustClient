// Extract factual heading/image metadata from the original balance-note site.
// Sources are pinned; JavaScript, styling and prose are not imported.
import { Window } from "happy-dom";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_REVISION = "0d01e845da4d72173492751d153771ee17a0f079";
const REPOSITORY = "FAForever/patchnotes";
const OUTPUT = "crates/faf-domain/src/protocol/data/historical_changelog.json";
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const HEADINGS = "h2,h3,h4,h5,h6";

function illustrations(root) {
  return [...root.querySelectorAll(`${HEADINGS},b,strong`)].filter(element =>
    /^H[2-6]$/.test(element.tagName) || element.previousElementSibling?.tagName === "IMG");
}

function headingImages(heading) {
  return /^H[2-6]$/.test(heading.tagName) ? [...heading.querySelectorAll("img[src]")]
    : [heading.previousElementSibling];
}

export function normalize(value) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// Stable text fingerprint, used only to associate unchanged published prose.
export function fingerprint(value) {
  const bytes = new TextEncoder().encode(normalize(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `${hash.toString(16).padStart(16, "0")}:${bytes.length}`;
}

function plain(value) {
  return value.replaceAll("\u2014", ", ").replace(/\s+/g, " ").trim();
}

function aliases(name) {
  const variants = [name, name.split("(")[0].trim()];
  for (const match of name.matchAll(/\(([^()]+)\)/g)) variants.push(match[1].trim());
  return [...new Set(variants.filter(value => normalize(value).length >= 3))];
}

export function assetPath(reference, assets) {
  if ([...reference].some(character => character === "\\" || character.charCodeAt(0) < 32)) return null;
  let url;
  try { url = new URL(reference, "https://patchnotes.faforever.com/balance/source.html"); }
  catch { return null; }
  if (url.hostname !== "patchnotes.faforever.com" || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) return null;
  let candidate;
  try { candidate = decodeURIComponent(url.pathname.slice(1)); }
  catch { return null; }
  if (!candidate.startsWith("images/") || !/\.(png|jpe?g|gif|webp)$/i.test(candidate)
    || candidate.split("/").some(part => !part || part === "." || part === "..")) return null;
  if (!assets.has(candidate)) {
    const matches = [...assets].filter(asset => asset.toLowerCase() === candidate.toLowerCase());
    if (matches.length !== 1) return null;
    [candidate] = matches;
  }
  return candidate.split("/").map(encodeURIComponent).join("/");
}

export async function extractPage(html, version, assets) {
  if (Buffer.byteLength(html) > MAX_DOCUMENT_BYTES || !/^\d{4}$/.test(version)) {
    throw new Error("Invalid historical document or version");
  }
  const window = new Window({ settings: {
    enableJavaScriptEvaluation: false, disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true, enableImageFileLoading: false, disableIframePageLoading: true,
  } });
  try {
    const document = new window.DOMParser().parseFromString(html, "text/html");
    const root = document.querySelector(".content") ?? document.querySelector("main") ?? document.body;
    const identity = `${document.title} ${root.querySelector("h1")?.textContent ?? ""}`;
    const versions = [...identity.matchAll(/\b\d{4}\b/g)].map(match => match[0]).filter(value => Number(value) >= 3500);
    if (!versions.length || versions.some(value => value !== version)) {
      throw new Error(`Historical page version mismatch: expected ${version}, found ${versions.join(", ") || "none"}`);
    }
    const headings = [];
    const context = [];
    const deduplicated = new Map();
    const warnings = [];
    for (const heading of illustrations(root)) {
      const level = /^H[2-6]$/.test(heading.tagName) ? Number(heading.tagName.slice(1)) : 4;
      const name = plain(heading.textContent ?? "");
      while (context.length && context.at(-1).level >= level) context.pop();
      const images = headingImages(heading);
      if (level >= 3 && images.length && name && name.length <= 256 && headings.length < 1024) {
        const paths = [...new Set(images.map(image => {
          const reference = image.getAttribute("src") ?? "";
          const resolved = assetPath(reference, assets);
          if (!resolved) warnings.push(`Unavailable image for ${name}: ${reference}`);
          return resolved;
        }).filter(Boolean))].slice(0, 8);
        const record = { name, context: context.map(item => item.name), aliases: aliases(name),
          images: paths, paragraphs: [], issues: [] };
        const card = heading.closest(".card") ?? heading.parentElement;
        const illustrated = card ? illustrations(card).filter(item => headingImages(item).length) : [];
        if (card && illustrated.length === 1) {
          record.paragraphs = [...new Set([...card.querySelectorAll("p")].map(paragraph =>
            plain(paragraph.textContent ?? "")).filter(value => {
            const length = normalize(value).length;
            return length >= 48 && length <= 4096;
          }).map(fingerprint))];
          record.issues = [...new Set([...card.querySelectorAll("a[href]")].flatMap(anchor => {
            const match = /^https:\/\/github\.com\/FAForever\/fa\/(?:pull|issues)\/(\d+)(?:[?#].*)?$/.exec(anchor.getAttribute("href") ?? "");
            return match ? [match[1]] : [];
          }))];
          // Bold captions grouped under this heading, such as the three
          // missiles under 3718's "Nukes", which a post lists as bullets of
          // their own. Fingerprints only, like the prose.
          const members = [...card.children]
            .filter(element => /^(B|STRONG)$/.test(element.tagName) && element.previousElementSibling?.tagName !== "IMG")
            .map(element => plain(element.textContent ?? ""))
            .filter(value => normalize(value).length && value.length <= 256)
            .map(fingerprint);
          if (members.length) record.members = [...new Set(members)];
        }
        const key = JSON.stringify([normalize(name), record.context.map(normalize), paths]);
        const previous = deduplicated.get(key);
        if (previous) {
          previous.paragraphs = [...new Set([...previous.paragraphs, ...record.paragraphs])];
          previous.issues = [...new Set([...previous.issues, ...record.issues])];
          if (record.members) previous.members = [...new Set([...previous.members ?? [], ...record.members])];
        } else {
          headings.push(record);
          deduplicated.set(key, record);
        }
      }
      if (name && name.length <= 256) context.push({ level, name });
    }
    return { headings, warnings };
  } finally {
    await window.happyDOM.close();
  }
}

async function publicText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} reading ${url}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error("Historical source exceeds size limit");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function generate({ cacheDir, fetchSources = false }) {
  const treeFile = path.join(cacheDir, "tree.json");
  await mkdir(path.join(cacheDir, "balance"), { recursive: true });
  if (fetchSources) {
    const url = `https://api.github.com/repos/${REPOSITORY}/git/trees/${SOURCE_REVISION}?recursive=1`;
    await writeFile(treeFile, await publicText(url));
  }
  const tree = JSON.parse(await readFile(treeFile, "utf8"));
  if (tree.truncated || tree.sha !== SOURCE_REVISION) throw new Error("Incorrect or truncated historical repository tree");
  const assets = new Set(tree.tree.filter(item => item.type === "blob").map(item => item.path));
  const pages = [...assets].filter(file => /^balance\/\d{4}\.html$/.test(file)).sort();
  const patches = {};
  const warnings = [];
  for (const source of pages) {
    const version = path.basename(source, ".html");
    const local = path.join(cacheDir, source);
    if (fetchSources) await writeFile(local, await publicText(`https://raw.githubusercontent.com/${REPOSITORY}/${SOURCE_REVISION}/${source}`));
    let page;
    try { page = await extractPage(await readFile(local, "utf8"), version, assets); }
    catch (error) {
      if (!error.message.startsWith("Historical page version mismatch")) throw error;
      warnings.push(`${version}: skipped; ${error.message}`);
      continue;
    }
    if (page.headings.length) patches[version] = { source, headings: page.headings };
    warnings.push(...page.warnings.map(warning => `${version}: ${warning}`));
  }
  return { manifest: { revision: SOURCE_REVISION, patches }, warnings };
}

async function main() {
  const args = process.argv.slice(2);
  const cacheIndex = args.indexOf("--cache-dir");
  const cacheDir = path.resolve(cacheIndex < 0 ? "target/historical-changelog-source" : args[cacheIndex + 1]);
  const { manifest, warnings } = await generate({ cacheDir, fetchSources: args.includes("--fetch") });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.includes("--check")) {
    if (await readFile(OUTPUT, "utf8") !== serialized) throw new Error("Generated historical metadata differs; regenerate it");
  } else {
    await mkdir(path.dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, serialized);
  }
  console.log(`Historical metadata: ${Object.keys(manifest.patches).length} notes, ${Object.values(manifest.patches).reduce((sum, patch) => sum + patch.headings.length, 0)} headings.`);
  for (const warning of warnings) console.warn(warning);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
