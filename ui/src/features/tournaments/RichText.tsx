// An organiser's formatted prose, drawn as elements.
//
// The one rule this component exists to keep: no `dangerouslySetInnerHTML`,
// ever. The website builds an HTML string and assigns it, which is safe there
// because a browser tab is already the untrusted surface; here the same string
// would land in the client's own document. So the parse in `shared/markdown`
// answers with a tree, and this walks it. Text stays text whatever it contains.

import { Fragment } from "react";
import type { MarkdownBlock, MarkdownSpan } from "../../shared/markdown";
import { parseMarkdown } from "../../shared/markdown";
import { openHttpsUrl } from "../../shared/externalLinks";

interface RichTextProps {
  /** Markdown source, as the organiser typed it. */
  source: string;
  /** Where the service lives, for resolving its own image paths. */
  assetBase: string;
  /** Extra class on the wrapper, for the callers that size their own box. */
  className?: string;
}

function spanContent(span: MarkdownSpan, key: number) {
  if (span.kind === "image") {
    return (
      <img key={key} className="rich-text-inline-image" src={span.url} alt={span.alt} loading="lazy" />
    );
  }

  if (span.kind === "link") {
    // A button rather than an anchor: the desktop shell opens links through the
    // OS, and an anchor with a real href is one mis-click away from navigating
    // the application window to a remote document.
    return (
      <button
        key={key}
        type="button"
        className="rich-text-link"
        onClick={() => {
          void openHttpsUrl(span.url);
        }}
        title={span.url}
      >
        {span.text}
      </button>
    );
  }

  let content = <>{span.text}</>;
  if (span.bold) content = <strong>{content}</strong>;
  if (span.italic) content = <em>{content}</em>;
  if (span.underline) content = <u>{content}</u>;
  return <Fragment key={key}>{content}</Fragment>;
}

function block(entry: MarkdownBlock, key: number) {
  if (entry.kind === "image") {
    return <img key={key} className="rich-text-image" src={entry.url} alt={entry.alt} loading="lazy" />;
  }

  const spans = entry.spans.map(spanContent);

  if (entry.kind === "heading") {
    // Fixed levels rather than real headings: this sits inside a pane that
    // already has a heading structure, and an organiser's `#` must not
    // outrank the section it is written in.
    return (
      <p key={key} className={`rich-text-h${entry.level}`}>
        {spans}
      </p>
    );
  }

  if (entry.kind === "bullet") {
    return (
      <p key={key} className="rich-text-bullet">
        {spans}
      </p>
    );
  }

  return (
    <p key={key} className="rich-text-line">
      {spans}
    </p>
  );
}

export function RichText({ source, assetBase, className }: RichTextProps) {
  const trimmed = source.trim();
  if (trimmed === "") return null;
  const blocks = parseMarkdown(trimmed, assetBase);
  return (
    <div className={className === undefined ? "rich-text" : `rich-text ${className}`}>
      {blocks.map(block)}
    </div>
  );
}
