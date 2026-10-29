// Regenerate the inert archive from reviewed, pinned source documents.
import { Window } from "happy-dom";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function blogDocument(raw) {
  const value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  return { title: value.title?.rendered ?? value.title, date: value.date,
    original: value.link ?? value.original, body: value.content?.rendered ?? value.body };
}

export function sourceHash(source, format) {
  const document = format === "blog-json" ? blogDocument(source) : null;
  const normalized = document ? JSON.stringify({ date: document.date, original: document.original, body: document.body })
    : source.replaceAll("\r\n", "\n").trimEnd();
  return createHash("sha256").update(normalized).digest("hex");
}

const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const allowed = new Set(["P", "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "CODE", "PRE", "BR", "A", "S", "DEL"]);
const inline = new Set(["STRONG", "B", "EM", "I", "CODE", "A", "S", "DEL"]);
const dropped = "script,style,iframe,object,embed,form,input,button,svg,template,#toc,.mw-editsection,.sharedaddy,.entry-meta,.post-navigation";

function safeLink(value, base, snapshot) {
  try {
    const url = new URL(value, base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    // Preserve old wiki references at the verified capture, never as a PR number.
    if (snapshot && url.hostname === "wiki.faforever.com") return `https://web.archive.org/web/${snapshot}/${url.href}`;
    return url.href;
  } catch { return null; }
}

/** Inert parsing, allowlisted output and no fetching of referenced resources. */
export function extractNote(html, format, base, snapshot = "") {
  if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw new Error("Oversized archive source");
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true, disableIframePageLoading: true, disableComputedStyleRendering: true } });
  try {
    window.document.body.innerHTML = html;
    const root = window.document.querySelector(format === "wiki" ? "#mw-content-text" : ".entry-content");
    if (!root) throw new Error("Missing archive article body");
    root.querySelectorAll(dropped).forEach(node => node.remove());
    const genericHeading = node => /^change\s*log$/i.test(node.textContent.trim());
    const headingOffset = [...root.querySelectorAll("h1")].some(node => !genericHeading(node)) ? 1 : 0;
    let visited = 0;
    const serialize = (node, depth = 0) => {
      if (++visited > 20000 || depth > 32) throw new Error("Archive markup exceeds limits");
      if (node.nodeType === 3) return escape(node.textContent ?? "");
      if (node.nodeType !== 1) return "";
      const tag = node.tagName;
      const inner = [...node.childNodes].map(child => serialize(child, depth + 1)).join("");
      if (tag === "IMG") {
        const label = escape(node.getAttribute("alt") || "Original illustration");
        const href = safeLink(node.getAttribute("src") ?? "", base, snapshot);
        return href ? ` <a href="${escape(href)}">${label}</a> ` : escape(node.getAttribute("alt") ?? "");
      }
      if (!allowed.has(tag)) return inner;
      if (tag === "BR") return "<br>";
      // Keep caption-edge spaces outside inline tags, where the native span
      // parser retains them. Whitespace-only emphasis remains a separator.
      if (inline.has(tag)) {
        if (!node.textContent.trim()) return escape(node.textContent);
        const before = inner.match(/^\s+/)?.[0] ?? "";
        const after = inner.match(/\s+$/)?.[0] ?? "";
        const caption = inner.trim();
        if (tag === "A") {
          const href = safeLink(node.getAttribute("href") ?? "", base, snapshot);
          return before + (href ? `<a href="${escape(href)}">${caption}</a>` : caption) + after;
        }
        return `${before}<${tag.toLowerCase()}>${caption}</${tag.toLowerCase()}>${after}`;
      }
      if (!node.textContent.trim()) return "";
      if (tag === "H1" && genericHeading(node)) return `<p><strong>${inner}</strong></p>`;
      if (/^H[1-6]$/.test(tag)) {
        const level = Math.min(6, Number(tag[1]) + headingOffset);
        return `<h${level}>${inner}</h${level}>`;
      }
      // MediaWiki often represents separate bullet lines as separate paragraphs.
      // Keep multiline stat tables legible instead of collapsing them into prose.
      if (format === "wiki" && tag === "P" && node.textContent.trim().split("\n").filter(line => line.trim()).length > 1 && !node.querySelector("a,strong,b,em,i")) {
        return `<pre>${escape(node.textContent.trim())}</pre>`;
      }
      return `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
    };
    const result = [...root.childNodes].map(node => serialize(node)).join("").trim();
    if (!result || !root.textContent.trim()) throw new Error("Empty archive note");
    return result;
  } finally { window.happyDOM.abort(); }
}

export async function regenerate(root, cache, check = false) {
  const manifest = JSON.parse(await readFile(path.join(root, "scripts/data/early-changelog-sources.json"), "utf8"));
  const notes = [];
  for (const source of manifest.sources) {
    if (source.existing) continue;
    const raw = await readFile(path.join(cache, source.file), "utf8");
    if (sourceHash(raw, source.format) !== source.sha256) throw new Error(`Source changed: ${source.id}`);
    const document = source.format === "blog-json" ? `<div class="entry-content">${blogDocument(raw).body}</div>` : raw;
    const html = extractNote(document, source.format, source.originalUrl, source.capture ?? "");
    notes.push({ id: source.kind === "Legacy notes" ? `legacy-${source.id}` : source.id, patch: source.id,
      kind: source.kind, date: source.date, year: source.date.slice(0, 4),
      sourceUrl: source.sourceUrl, html, evidence: source.evidence });
  }
  const output = `${JSON.stringify({ seed: manifest.seed, notes, corrections: manifest.corrections }, null, 2)}\n`;
  const destination = path.join(root, "crates/faf-domain/src/protocol/data/early_changelog.json");
  if (check) {
    if (await readFile(destination, "utf8") !== output) throw new Error("Early changelog archive is stale");
  } else await writeFile(destination, output);
  return notes.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cacheArg = process.argv.findIndex(arg => arg === "--cache");
  const cache = cacheArg >= 0 ? path.resolve(process.argv[cacheArg + 1]) : path.join(root, "target/early-changelog-source");
  if (process.argv.includes("--fetch")) {
    const manifest = JSON.parse(await readFile(path.join(root, "scripts/data/early-changelog-sources.json"), "utf8"));
    await mkdir(cache, { recursive: true });
    // Sequential by design: these old sources are small and the archive is rate limited.
    for (const source of manifest.sources.filter(source => !source.existing)) {
      const url = new URL(source.fetchUrl);
      if (!["web.archive.org", "direct.faforever.com"].includes(url.hostname) || url.protocol !== "https:") throw new Error("Unapproved source host");
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Source unavailable: ${source.id}`);
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > 4 * 1024 * 1024) throw new Error("Oversized archive source");
        chunks.push(chunk);
      }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      if (sourceHash(raw, source.format) !== source.sha256) throw new Error(`Source changed: ${source.id}`);
      await writeFile(path.join(cache, source.file), raw);
    }
  }
  console.log(`${await regenerate(root, cache, process.argv.includes("--check"))} verified historical notes.`);
}
