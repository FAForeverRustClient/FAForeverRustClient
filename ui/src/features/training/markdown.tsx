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

import type { ReactNode } from "react";
import type { AppCommand } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { replayUidFromLink } from "../../shared/replayLinks";

export type ListBlock = { kind: "list"; ordered: boolean; items: ListItem[] };

/** One item, and the lists indented under it. */
export type ListItem = { text: string; children: ListBlock[] };

export type Align = "left" | "center" | "right" | null;

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | ListBlock
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; align: Align[]; header: string[]; rows: string[][] };

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
      // Three levels. `#` used to collapse into `##`, which was defensible
      // while the destination was a forum post whose title was a separate
      // field: there was nothing for the top level to mean. A guide is a
      // document of its own, so its sections need to look like sections and a
      // `#` has to outrank a `##`. Deeper than three still flattens, because a
      // preview pane is not a document outline.
      const depth = heading[1].length;
      blocks.push({
        kind: "heading",
        level: depth === 1 ? 1 : depth === 2 ? 2 : 3,
        text: heading[2].trim(),
      });
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

/** Inline spans: bold, italic, code, images and links. */
type Span =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "image"; text: string; src: string }
  | { kind: "link"; text: string; href: string };

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))/;

/** A character that makes an underscore next to it part of a word. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export function parseSpans(text: string): Span[] {
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
    if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ kind: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("![")) {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      // The same rule as a link: only ordinary HTTPS is fetched. Anything
      // else stays as typed, so the author sees it was not taken.
      const src = image ? optionalHttpsUrl(image[2]) : null;
      if (image && src) {
        spans.push({ kind: "image", text: image[1], src });
      } else {
        pushText(token);
      }
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      // A link whose destination is not ordinary HTTPS keeps its text and
      // loses its href: the same rule the rest of the client applies to a URL
      // it did not write, and the reason this preview never produces an
      // anchor it has not validated.
      const href = link ? optionalHttpsUrl(link[2]) : null;
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

function renderSpans(text: string): ReactNode[] {
  return parseSpans(text).map((span, index) => {
    switch (span.kind) {
      case "strong":
        return <strong key={index}>{span.text}</strong>;
      case "em":
        return <em key={index}>{span.text}</em>;
      case "code":
        return <code key={index}>{span.text}</code>;
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
            className="training-markdown-image"
          />
        );
      case "link": {
        // A build order cites its replays by their vault address, and this is
        // a client: it can play one. Sending somebody to a browser to press
        // download, then back here to open the file, is three steps to do what
        // the client does in one. Every other link still opens outside.
        const uid = replayUidFromLink(span.href);
        return (
          <a
            key={index}
            href={span.href}
            className={uid === null ? undefined : "training-markdown-replay"}
            onClick={(event) => {
              event.preventDefault();
              if (uid === null) {
                void openHttpsUrl(span.href);
                return;
              }
              ipc.send({
                kind: "Replays",
                command: { type: "watchVault", payload: { uid } },
              } satisfies AppCommand);
            }}
          >
            {span.text}
          </a>
        );
      }
      case "text":
        return <span key={index}>{span.text}</span>;
    }
  });
}

function renderList(block: ListBlock, key: number): ReactNode {
  const items = block.items.map((item, itemIndex) => (
    <li key={itemIndex}>
      {renderSpans(item.text)}
      {item.children.map((child, childIndex) => renderList(child, childIndex))}
    </li>
  ));
  return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
}

/** Render the supported subset of `source` as React nodes. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={className ? `training-markdown ${className}` : "training-markdown"}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading": {
            // h3/h4/h5 rather than h1/h2/h3: this renders inside a panel that
            // already has a heading of its own, so starting at h1 would claim
            // the page's outline.
            if (block.level === 1) return <h3 key={index}>{renderSpans(block.text)}</h3>;
            if (block.level === 2) return <h4 key={index}>{renderSpans(block.text)}</h4>;
            return <h5 key={index}>{renderSpans(block.text)}</h5>;
          }
          case "paragraph":
            return <p key={index}>{renderSpans(block.text)}</p>;
          case "quote":
            return <blockquote key={index}>{renderSpans(block.text)}</blockquote>;
          case "code":
            return <pre key={index}>{block.text}</pre>;
          case "list":
            return renderList(block, index);
          case "table":
            // Wrapped so a wide table scrolls inside the guide instead of
            // widening the pane it sits in.
            return (
              <div key={index} className="training-markdown-table">
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, column) => (
                        <th key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                          {renderSpans(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, column) => (
                          <td key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                            {renderSpans(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
