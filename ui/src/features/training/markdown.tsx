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
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string };

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

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const items: string[] = [];
      while (index < lines.length) {
        const next = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[index])
          : /^\s*[-*+]\s+(.*)$/.exec(lines[index]);
        if (!next) break;
        items.push(next[1].trim());
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return blocks;
}

/** Inline spans: bold, italic, code, and links. */
type Span =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)\s]+\))/;

export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  let rest = text;

  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      spans.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0) {
      spans.push({ kind: "text", text: rest.slice(0, match.index) });
    }
    const token = match[0];
    if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ kind: "strong", text: token.slice(2, -2) });
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
        spans.push({ kind: "text", text: token });
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
      case "link":
        return (
          <a
            key={index}
            href={span.href}
            onClick={(event) => {
              event.preventDefault();
              void openHttpsUrl(span.href);
            }}
          >
            {span.text}
          </a>
        );
      case "text":
        return <span key={index}>{span.text}</span>;
    }
  });
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
            return block.ordered ? (
              <ol key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderSpans(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderSpans(item)}</li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}
