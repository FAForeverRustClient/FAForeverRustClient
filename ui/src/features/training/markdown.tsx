// A small Markdown preview for the submission editor.
//
// Written here rather than pulled in, for two reasons that both matter more
// than the feature does:
//
// 1. **No HTML is ever constructed.** Every renderer worth using takes the
//    `dangerouslySetInnerHTML` route, and this client's whole posture towards
//    third-party markup is the opposite one: organiser-authored HTML is reduced
//    to plain text at the boundary (`protocol::markup`) precisely so it cannot
//    land in the client's own document. A preview of what the *player* typed is
//    a smaller risk than that, but it is the same shape of risk, and the answer
//    is the same: build React nodes, never markup.
// 2. **It is a preview, not a renderer.** The destination is the FAF forum,
//    which does its own Markdown. What this has to do is show the author that
//    their headings are headings before they post, and the subset below is the
//    part of Markdown people actually use for a guide.
//
// Unsupported syntax is shown verbatim rather than swallowed, which is the
// honest failure: the forum may still render it, and hiding it here would be a
// preview that lies in the other direction.

import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import type { AppCommand } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { replayUidFromLink } from "../../shared/replayLinks";
import { videoEmbedUrl, videoThumbnailUrl } from "./trainingPresentation";

export type ListBlock = { kind: "list"; ordered: boolean; items: ListItem[] };

/** One item, and the lists indented under it. */
export type ListItem = { text: string; children: ListBlock[] };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "paragraph"; text: string }
  | ListBlock
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "table"; align: Align[]; header: string[]; rows: string[][] }
  /**
   * The wiki's `## Title{.tabset}`: a heading it never shows, whose child
   * headings (one level deeper) become tabs over the text under each, until
   * the next heading at its own level or above.
   */
  | { kind: "tabset"; level: 1 | 2 | 3 | 4 };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Leading whitespace as columns, a tab counting as four. */
function indentOf(whitespace: string): number {
  let width = 0;
  for (const char of whitespace) width += char === "\t" ? 4 : 1;
  return width;
}

/**
 * Read one list starting at `start`, and every list indented under it.
 *
 * Indentation decides nesting: an item at least two columns deeper than the
 * list's own items belongs to a list under the item above it, an item
 * shallower than the list ends it. Switching between bullets and numbers at the
 * same depth also ends it, which is how Markdown reads that too.
 */
function readList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start]);
  const depth = first ? indentOf(first[1]) : 0;
  const ordered = first !== null && /\d/.test(first[2]);
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index]);
    if (!match) break;
    const indent = indentOf(match[1]);
    if (indent < depth) break;
    if (indent >= depth + 2 && items.length > 0) {
      const nested = readList(lines, index);
      items[items.length - 1].children.push(nested.block);
      index = nested.next;
      continue;
    }
    if (/\d/.test(match[2]) !== ordered) break;
    items.push({ text: match[3].trim(), children: [] });
    index += 1;
  }
  return { block: { kind: "list", ordered, items }, next: index };
}

/** A GFM delimiter row: `| --- | :-: |`, pipes at the ends optional. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split one table row into its cells, honouring `\|` as a literal pipe. */
export function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (row[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += row[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** Whether `line` and the one after it open a table. */
function opensTable(line: string, next: string | undefined): boolean {
  if (next === undefined || !line.includes("|")) return false;
  // A delimiter row needs a pipe as well, or a heading underlined with dashes
  // would read as a one-column table.
  return next.includes("|") && TABLE_DELIMITER.test(next);
}

/** Split the source into blocks. Line-based, which is all the subset needs. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  const paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph.length = 0;
    }
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    // Fenced code, kept exactly as typed: a build order pasted into a guide is
    // the main thing anyone puts in a fence, and reflowing it would ruin it.
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // the closing fence, or the end of the source
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      // Four levels. `#` used to collapse into `##`, which was defensible
      // while the destination was a forum post whose title was a separate
      // field: there was nothing for the top level to mean. A guide is a
      // document of its own, so its sections need to look like sections and a
      // `#` has to outrank a `##`. The wiki's guides go one deeper than that
      // (`### Basics`, then `#### Mass` and `#### Energy` under it), and
      // flattening the fourth into the third put a topic and its own parts at
      // the same rank. Deeper than four still flattens.
      const depth = heading[1].length;
      // A tabset heading is one the wiki never shows: it turns the headings
      // under it into tabs and draws no title of its own. The copied guides
      // lean on that, writing a visible "## Spending Resources" over a
      // "## Spending Resources{.tabset}", so showing it put every such title
      // on the page twice. What it keeps is where the tabs start.
      if (/\{[^}]*\.tabset\b[^}]*\}\s*$/.test(heading[2])) {
        blocks.push({ kind: "tabset", level: Math.min(depth, 4) as 1 | 2 | 3 | 4 });
        index += 1;
        continue;
      }
      blocks.push({
        kind: "heading",
        level: Math.min(depth, 4) as 1 | 2 | 3 | 4,
        // A trailing attribute block (`## Early Game{.tabset}`) is an
        // instruction to the wiki's renderer, not part of the title.
        text: heading[2].replace(/\s*\{[.#][^}]*\}\s*$/, "").trim(),
      });
      index += 1;
      continue;
    }

    // A rule on its own line. Read after headings, so a `---` under a line of
    // text is still a paragraph followed by a rule rather than a heading.
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (opensTable(line, lines[index + 1])) {
      flushParagraph();
      const header = tableCells(line);
      const align = tableCells(lines[index + 1]).map((cell): Align => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
      });
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() !== "" && lines[index].includes("|")) {
        // Every row is cut or padded to the header's width, as GFM does: a row
        // with a cell too many must not widen the table.
        const cells = tableCells(lines[index]);
        rows.push(header.map((_, column) => cells[column] ?? ""));
        index += 1;
      }
      blocks.push({
        kind: "table",
        align: header.map((_, column) => align[column] ?? null),
        header,
        rows,
      });
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoted.join(" ") });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph();
      const list = readList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return blocks;
}

/**
 * Where a picture of its own sits: beside the text on one side, or centred.
 * The wiki writes it as an attribute block after the image,
 * `![](map.png){.align-right}`, which Wiki.js reads and plain Markdown shows
 * as text.
 */
export type FigureAlign = "left" | "right" | "center";

/** Inline spans: bold, italic, code, images, links and line breaks. */
type Span =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string; em?: boolean }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "image"; text: string; src: string; icon?: boolean; align?: FigureAlign }
  | { kind: "link"; text: string; href: string }
  | { kind: "key"; text: string }
  | { kind: "break" };

/**
 * The inline syntax read, in the order it is tried. The last three are the
 * only HTML ever honoured, because Markdown has no way to say any of them and
 * GitHub, where the guides live, reads all three: a line break inside a table
 * cell, an image at a stated size (the resource icons in front of "Mass" and
 * "Energy"), and a key on the keyboard. All become React elements; nothing
 * here is ever parsed as markup.
 */
const INLINE =
  /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(!\[[^\]]*\]\([^)\s]+\)(?:\{[^}\n]*\})?)|(\[[^\]]+\]\([^)\s]+\))|(<\/?br\s*\/?>)|(<img\s[^>]*>)|(<kbd>[^<\n]{1,40}<\/kbd>)/i;

/** An HTML image tag's `src`, its `width` when it states one, and its `alt`. */
const IMG_SRC = /\ssrc\s*=\s*["']([^"']+)["']/i;
const IMG_WIDTH = /\swidth\s*=\s*["']?(\d+)/i;
const IMG_ALT = /\salt\s*=\s*["']([^"']*)["']/i;

/**
 * Open a link inside the client, when it names something the client can show
 * itself: another guide of the catalogue, for one. Answers whether it did; a
 * link it did not take opens in the browser as before. Outside a provider
 * (the submission preview) nothing is taken.
 */
export const GuideLinks = createContext<(href: string) => boolean>(() => false);

/**
 * An address as the guide wrote it, made absolute.
 *
 * Guides copied from a site keep that site's own relative links (the wiki's
 * `/Play/Windows-Install`), which mean nothing in the client. With the page
 * the guide came from as the base they point back where they always did.
 * Without a base, or for anything that does not resolve to ordinary HTTPS,
 * the answer is `null` and the caller leaves the text as typed.
 */
export function resolveAddress(address: string, base?: Addresses): string | null {
  const direct = optionalHttpsUrl(address);
  const page = typeof base === "string" ? base : base?.page;
  if (direct || !page) return direct;
  try {
    return optionalHttpsUrl(new URL(address, page).toString());
  } catch {
    return null;
  }
}

/**
 * What a guide's relative addresses are relative to.
 *
 * A plain string is the page the guide was copied from, which is all a guide
 * ever had. The object form adds the two things a guide written in the client
 * needs for its pictures:
 *
 * - `document`, where the guide's own file is read from. A picture written as
 *   `images/<id>/map.png` sits beside the guide in the repository, which is
 *   how GitHub and every Markdown viewer read a relative path.
 * - `local`, pictures the author attached and has not sent yet, by the path
 *   the editor wrote (`images/map.png`), as addresses this client made for
 *   them.
 */
export type Addresses =
  | string
  | { page?: string; document?: string; local?: ReadonlyMap<string, string> };

/** A path relative to the file it is written in: no scheme, not rooted. */
const DOCUMENT_RELATIVE = /^(?![a-z][a-z0-9+.-]*:)(?!\/)[^\s]+$/i;

/**
 * A picture's address made absolute.
 *
 * A picture the author attached is shown from the client's own copy until it
 * is sent. A relative path names a file beside the guide, so it is resolved
 * against the guide's own address; a rooted one (`/images/...`, what a copied
 * wiki page writes) means the site the guide came from, exactly as a link
 * does. Only ordinary HTTPS is ever fetched.
 */
export function resolveImage(address: string, base?: Addresses): string | null {
  if (typeof base === "object") {
    const local = base.local?.get(address);
    if (local) return local;
    if (base.document && DOCUMENT_RELATIVE.test(address)) {
      try {
        const resolved = optionalHttpsUrl(new URL(address, base.document).toString());
        if (resolved) return resolved;
      } catch {
        // Falls through to the page, like any other address that did not resolve.
      }
    }
  }
  return resolveAddress(address, base);
}

/**
 * A link's address made absolute. A relative `.md` is another guide beside
 * this one, the way GitHub reads it, so it resolves against the guide's own
 * file; everything else means the page the guide came from, as before.
 */
export function resolveLink(address: string, base?: Addresses): string | null {
  if (typeof base === "object" && base.document && /\.md(?:#.*)?$/i.test(address)) {
    if (DOCUMENT_RELATIVE.test(address)) {
      try {
        const resolved = optionalHttpsUrl(new URL(address, base.document).toString());
        if (resolved) return resolved;
      } catch {
        // Falls through to the page, like any other address that did not resolve.
      }
    }
  }
  return resolveAddress(address, base);
}

/** A character that makes an underscore next to it part of a word. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export function parseSpans(text: string, base?: Addresses): Span[] {
  const spans: Span[] = [];
  let rest = text;
  // Adjacent text is kept as one span, so declining a marker below does not
  // split a word in two.
  const pushText = (value: string) => {
    const last = spans[spans.length - 1];
    if (last && last.kind === "text") last.text += value;
    else spans.push({ kind: "text", text: value });
  };

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      pushText(rest);
      break;
    }
    const token = match[0];
    // Underscore emphasis only opens and closes at a word boundary, as in
    // GFM: `snake_case_name` is an identifier somebody typed, not a word in
    // italics. Asterisks keep working inside a word, which GFM also does.
    // Checked here rather than with a lookbehind in the pattern, which older
    // WebKit builds reject outright and would take the whole module down.
    if (token.startsWith("_")) {
      const offset = text.length - rest.length + match.index;
      const before = offset > 0 ? text[offset - 1] : "";
      const after = text[offset + token.length] ?? "";
      if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) {
        pushText(rest.slice(0, match.index + 1));
        rest = rest.slice(match.index + 1);
        continue;
      }
    }
    if (match.index > 0) {
      pushText(rest.slice(0, match.index));
    }
    if (/^<\/?br/i.test(token)) {
      spans.push({ kind: "break" });
    } else if (/^<kbd>/i.test(token)) {
      spans.push({ kind: "key", text: token.slice(5, -6).trim() });
    } else if (/^<img/i.test(token)) {
      const src = IMG_SRC.exec(token);
      const resolved = src ? resolveImage(src[1], base) : null;
      if (resolved) {
        const width = Number(IMG_WIDTH.exec(token)?.[1] ?? 0);
        spans.push({
          kind: "image",
          text: IMG_ALT.exec(token)?.[1] ?? "",
          src: resolved,
          // A picture sized like a glyph is one, and sits in the line.
          icon: width > 0 && width <= 32,
        });
      } else {
        pushText(token);
      }
    } else if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("***")) {
      spans.push({ kind: "strong", text: token.slice(3, -3), em: true });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ kind: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("![")) {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)\)(?:\{([^}]*)\})?$/.exec(token);
      // The same rule as a link: only ordinary HTTPS is fetched. Anything
      // else stays as typed, so the author sees it was not taken.
      const src = image ? resolveImage(image[2], base) : null;
      if (image && src) {
        // The attribute block is an instruction to the wiki's renderer: the
        // alignment it states is kept, anything else in it is dropped rather
        // than shown as text under the picture.
        const align = /\.align-(left|right|center)\b/.exec(image[3] ?? "")?.[1] as
          | FigureAlign
          | undefined;
        spans.push(
          align ? { kind: "image", text: image[1], src, align } : { kind: "image", text: image[1], src },
        );
      } else {
        pushText(token);
      }
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      // A link whose destination is not ordinary HTTPS keeps its text and
      // loses its href: the same rule the rest of the client applies to a URL
      // it did not write, and the reason this preview never produces an
      // anchor it has not validated.
      const href = link ? resolveLink(link[2], base) : null;
      if (link && href) {
        spans.push({ kind: "link", text: link[1], href });
      } else {
        pushText(token);
      }
    } else {
      spans.push({ kind: "em", text: token.slice(1, -1) });
    }
    rest = rest.slice(match.index + token.length);
  }

  return spans;
}

export function renderSpans(text: string, base?: Addresses): ReactNode[] {
  return parseSpans(text, base).map((span, index) => {
    switch (span.kind) {
      case "break":
        return <br key={index} />;
      case "strong":
        return (
          <strong key={index}>{span.em ? <em>{span.text}</em> : span.text}</strong>
        );
      case "em":
        return <em key={index}>{span.text}</em>;
      case "code":
        return <code key={index}>{span.text}</code>;
      case "key":
        return (
          <kbd key={index} className="training-markdown-key">
            {span.text}
          </kbd>
        );
      case "image":
        // An element React builds from a validated address, with the alt text
        // as an attribute, never markup. No referrer, so the hosts of a
        // guide's images do not learn who is reading it.
        return (
          <img
            key={index}
            src={span.src}
            alt={span.text}
            title={span.text || undefined}
            loading="lazy"
            referrerPolicy="no-referrer"
            className={span.icon ? "training-markdown-icon" : "training-markdown-image"}
          />
        );
      case "link":
        return <GuideLink key={index} href={span.href} text={span.text} />;
      case "text":
        return <span key={index}>{span.text}</span>;
    }
  });
}

/**
 * A link in a guide, opened where it is best read.
 *
 * A build order cites its replays by their vault address, and this is a
 * client: it can play one. Sending somebody to a browser to press download,
 * then back here to open the file, is three steps to do what the client does
 * in one. A link to another guide of the catalogue opens that guide here, for
 * the same reason. Every other link still opens outside.
 */
function GuideLink({ href, text }: { href: string; text: string }) {
  const openInside = useContext(GuideLinks);
  const uid = replayUidFromLink(href);
  return (
    <a
      href={href}
      className={uid === null ? undefined : "training-markdown-replay"}
      onClick={(event) => {
        event.preventDefault();
        if (uid !== null) {
          ipc.send({
            kind: "Replays",
            command: { type: "watchVault", payload: { uid } },
          } satisfies AppCommand);
          return;
        }
        if (!openInside(href)) void openHttpsUrl(href);
      }}
    >
      {text}
    </a>
  );
}

function renderList(block: ListBlock, key: number, base?: Addresses): ReactNode {
  const items = block.items.map((item, itemIndex) => (
    <li key={itemIndex}>
      {renderSpans(item.text, base)}
      {item.children.map((child, childIndex) => renderList(child, childIndex, base))}
    </li>
  ));
  return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
}

/**
 * A paragraph that is nothing but one picture, as a figure.
 *
 * That is how a guide puts a screenshot between two paragraphs, and drawn
 * inline it sat on a text line with a line's spacing around it. As a figure it
 * gets the room of a block and its alt text as the caption under it, which is
 * where the guide's author put the explanation.
 */
function soleImage(text: string, base?: Addresses) {
  const spans = parseSpans(text.trim(), base);
  const only = spans.length === 1 ? spans[0] : null;
  return only && only.kind === "image" && !only.icon ? only : null;
}

/**
 * Where a video address asks playback to start, in seconds: `t=95`, `t=95s`,
 * `t=1m35s`, `t=1h01m7s`, and the `21m00` a hand-typed link sometimes has.
 */
export function videoStart(href: string): number {
  const raw = /[?&#](?:t|start)=([0-9hms]+)/i.exec(href)?.[1];
  if (!raw) return 0;
  if (/^\d+s?$/i.test(raw)) return Number.parseInt(raw, 10);
  const part = (unit: string) => Number(new RegExp(`(\\d+)${unit}`, "i").exec(raw)?.[1] ?? 0);
  const trailing = /m(\d+)$/i.exec(raw)?.[1];
  return part("h") * 3600 + part("m") * 60 + (trailing ? Number(trailing) : part("s"));
}

/** Seconds as a clock: `1:05` or `1:01:07`. */
export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * A paragraph that is nothing but a link to a YouTube video, or its bare
 * address: the way a guide cites a video, one per line. Arma's lessons from
 * Zock cite a hundred and fifty of them, each above the passage it sums up.
 */
export function soleVideo(text: string, base?: Addresses): { href: string; label: string } | null {
  const trimmed = text.trim();
  const spans = parseSpans(trimmed, base);
  const only = spans.length === 1 ? spans[0] : null;
  if (only?.kind === "link" && videoThumbnailUrl(only.href)) {
    return { href: only.href, label: only.text === only.href ? "" : only.text };
  }
  const bare = optionalHttpsUrl(trimmed);
  if (only?.kind === "text" && bare && !/\s/.test(trimmed) && videoThumbnailUrl(bare)) {
    return { href: bare, label: "" };
  }
  return null;
}

/**
 * A cited video as a row: its still, what the guide calls it, and where it
 * starts. Pressed, it plays right there from that moment, because the reader
 * wants the thirty seconds the passage is about and not a browser tab.
 */
function VideoLine({ href, label }: { href: string; label: string }) {
  const { t } = useTranslation();
  // Which address was pressed, not just that something was: React keeps this
  // row's state by its place in the guide, and a flag alone carried "playing"
  // to whatever video stood in that place next (another guide opened, a line
  // added above it in the editor), which then started on its own.
  const [pressed, setPressed] = useState<string | null>(null);
  const playing = pressed === href;
  const start = videoStart(href);
  const embed = videoEmbedUrl(href);
  const name = label || t("training.guide.video");
  if (playing && embed) {
    return (
      <div className="training-markdown-video is-playing">
        <iframe
          src={`${embed}&autoplay=1${start > 0 ? `&start=${start}` : ""}`}
          title={name}
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
        <div className="training-markdown-video-bar">
          <span>{name}</span>
          <Button onClick={() => void openHttpsUrl(href)}>
            <Icon name="external" size={14} /> {t("training.guide.videoOnYouTube")}
          </Button>
          <Button onClick={() => setPressed(null)}>
            <Icon name="close" size={14} /> {t("training.guide.videoClose")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="training-markdown-video"
      onClick={() => (embed ? setPressed(href) : void openHttpsUrl(href))}
    >
      <span className="training-markdown-video-still">
        <img src={videoThumbnailUrl(href)} alt="" loading="lazy" referrerPolicy="no-referrer" />
        <span className="training-markdown-video-play" aria-hidden>
          <Icon name="play" size={14} />
        </span>
      </span>
      <span className="training-markdown-video-text">
        <strong>{name}</strong>
        {/* The start once: a label that already says "at 15:17" is not
            told again under it. */}
        <span>
          YouTube
          {start === 0
            ? ` · ${t("training.guide.videoWhole")}`
            : !name.includes(clock(start)) && ` · ${t("training.guide.videoFrom", { time: clock(start) })}`}
        </span>
      </span>
    </button>
  );
}

/**
 * One block as React nodes. Headings start at h3, because this renders inside
 * a panel that already has a heading of its own and starting at h1 would claim
 * the page's outline; the third and fourth levels share h5, since a preview
 * pane is not an outline. The guide reader draws its own headings.
 */
export function renderBlock(block: Block, key: number, base?: Addresses): ReactNode {
  switch (block.kind) {
    case "heading": {
      if (block.level === 1) return <h3 key={key}>{renderSpans(block.text, base)}</h3>;
      if (block.level === 2) return <h4 key={key}>{renderSpans(block.text, base)}</h4>;
      return <h5 key={key}>{renderSpans(block.text, base)}</h5>;
    }
    case "paragraph": {
      const video = soleVideo(block.text, base);
      if (video) return <VideoLine key={key} href={video.href} label={video.label} />;
      const figure = soleImage(block.text, base);
      if (figure) {
        return (
          <figure
            key={key}
            className={
              figure.align
                ? `training-markdown-figure is-align-${figure.align}`
                : "training-markdown-figure"
            }
          >
            <img src={figure.src} alt={figure.text} loading="lazy" referrerPolicy="no-referrer" />
            {/* A file name is what an editor fills the alt text with when
                nobody wrote one, and it is not a caption. */}
            {figure.text && !/\.(png|jpe?g|gif|webp)$/i.test(figure.text) && (
              <figcaption>{figure.text}</figcaption>
            )}
          </figure>
        );
      }
      return <p key={key}>{renderSpans(block.text, base)}</p>;
    }
    case "quote":
      return <blockquote key={key}>{renderSpans(block.text, base)}</blockquote>;
    case "code":
      return <pre key={key}>{block.text}</pre>;
    case "rule":
      return <hr key={key} />;
    case "tabset":
      // Only the guide reader lays tabs out; anywhere else the headings
      // under it read as headings.
      return null;
    case "list":
      return renderList(block, key, base);
    case "table":
      // Wrapped so a wide table scrolls inside the guide instead of widening
      // the pane it sits in.
      return (
        <div key={key} className="training-markdown-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <th key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                    {renderSpans(cell, base)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                      {renderSpans(cell, base)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Render the supported subset of `source` as React nodes. */
export function Markdown({
  source,
  className,
  base,
}: {
  source: string;
  className?: string;
  /** What its relative addresses are relative to: see [`Addresses`]. */
  base?: Addresses;
}) {
  const blocks = parseBlocks(source);
  return (
    <div className={className ? `training-markdown ${className}` : "training-markdown"}>
      {blocks.map((block, index) => renderBlock(block, index, base))}
    </div>
  );
}
