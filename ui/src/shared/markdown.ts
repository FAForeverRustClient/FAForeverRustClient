// The small markdown the tournament service understands, parsed into blocks.
//
// A twin of the website's `renderArticleBody` (`public/app.js`), and the twin
// stops at the parse: where it builds an HTML string and assigns `innerHTML`,
// this answers with a tree that the renderer turns into React elements. That is
// the whole security argument for holding these fields as source rather than
// reducing them to plain text on the way in. Two guarantees, either of which
// would do on its own:
//
//   - the service deletes every `<` and `>` from these fields (`cleanName`), so
//     a tag cannot survive being stored;
//   - nothing here emits markup. A `<script>` that somehow reached the state
//     renders as the eight characters it is.
//
// The subset, which is the website's exactly: `**bold**`, `*italic*`,
// `__underline__`, `#`/`##`/`###` headings, `- ` bullets, `[text](url)` links
// and `![alt](url)` images. Anything else is text.

/** One line of a body, already classified. */
export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; spans: MarkdownSpan[] }
  | { kind: "bullet"; spans: MarkdownSpan[] }
  | { kind: "paragraph"; spans: MarkdownSpan[] }
  | { kind: "image"; url: string; alt: string };

/** A run of text inside a line, with whatever emphasis applies to it. */
export type MarkdownSpan =
  | { kind: "text"; text: string; bold: boolean; italic: boolean; underline: boolean }
  | { kind: "link"; text: string; url: string }
  | { kind: "image"; url: string; alt: string };

/**
 * A url a link may point at.
 *
 * `https` only, which is narrower than the website (it takes `http` too) and
 * deliberately so: the client's own opener refuses everything else anyway, so a
 * link rendered as clickable and then refused on click would be a worse lie
 * than one rendered as the text it is.
 */
function linkUrl(raw: string): string | null {
  const url = raw.trim();
  return url.startsWith("https://") && !/[<>"'\s]/.test(url) ? url : null;
}

/**
 * A url an image may load from, resolved against the service.
 *
 * Two shapes, matching what the service can produce: its own upload path, which
 * is relative and needs the deployment's base, and an absolute `https` url.
 * `http` is refused here for a second reason beyond the one above: the desktop
 * shell's own content policy blocks it, so it could only ever render as a
 * broken image.
 */
function imageUrl(raw: string, assetBase: string): string | null {
  const url = raw.trim();
  if (/^\/desc-images\/[A-Za-z0-9_.%-]+$/.test(url)) {
    const base = assetBase.trim().replace(/\/+$/, "");
    return base === "" ? null : `${base}${url}`;
  }
  return url.startsWith("https://") && !/[<>"'\s]/.test(url) ? url : null;
}

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;
const BOLD = /\*\*([^*\n]+?)\*\*/;
const UNDERLINE = /__([^_\n]+?)__/;
const ITALIC = /\*([^*\n]+?)\*/;

/**
 * Split one line into spans.
 *
 * Images before links, because `![alt](url)` also matches the link pattern, and
 * emphasis last so a `**bold**` inside a link label is left as written rather
 * than half-parsed. Recursive on the remainder rather than a global replace:
 * the website's version replaces into a string, which it can only do because it
 * is building one.
 */
function spansOf(line: string, assetBase: string): MarkdownSpan[] {
  if (line === "") return [];

  const image = IMAGE.exec(line);
  if (image !== null) {
    const url = imageUrl(image[2], assetBase);
    // An image that cannot be resolved keeps its alt text: an organiser's
    // caption is worth more than a gap where a picture would have been.
    const span: MarkdownSpan =
      url === null
        ? { kind: "text", text: image[1], bold: false, italic: false, underline: false }
        : { kind: "image", url, alt: image[1] };
    return [
      ...spansOf(line.slice(0, image.index), assetBase),
      span,
      ...spansOf(line.slice(image.index + image[0].length), assetBase),
    ];
  }

  const link = LINK.exec(line);
  if (link !== null) {
    const url = linkUrl(link[2]);
    const span: MarkdownSpan =
      url === null
        ? { kind: "text", text: link[1], bold: false, italic: false, underline: false }
        : { kind: "link", text: link[1], url };
    return [
      ...spansOf(line.slice(0, link.index), assetBase),
      span,
      ...spansOf(line.slice(link.index + link[0].length), assetBase),
    ];
  }

  for (const [pattern, mark] of [
    [BOLD, "bold"],
    [UNDERLINE, "underline"],
    [ITALIC, "italic"],
  ] as const) {
    const found = pattern.exec(line);
    if (found === null) continue;
    const inner = spansOf(found[1], assetBase).map((span) =>
      span.kind === "text" ? { ...span, [mark]: true } : span,
    );
    return [
      ...spansOf(line.slice(0, found.index), assetBase),
      ...inner,
      ...spansOf(line.slice(found.index + found[0].length), assetBase),
    ];
  }

  return [{ kind: "text", text: line, bold: false, italic: false, underline: false }];
}

/**
 * Parse a body into blocks, one per line.
 *
 * Line-based like the website's, because the service's own editor is: a blank
 * line is a gap rather than a paragraph break, and the containers preserve it.
 * A line that is nothing but an image becomes an image block, which is what
 * lets a pasted screenshot be sized as a picture rather than as a word.
 */
export function parseMarkdown(source: string, assetBase = ""): MarkdownBlock[] {
  return source.split(/\r?\n/).map((raw): MarkdownBlock => {
    const line = raw.trimEnd();

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      return {
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        spans: spansOf(heading[2], assetBase),
      };
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      return { kind: "bullet", spans: spansOf(bullet[1], assetBase) };
    }

    const whole = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line.trim());
    if (whole !== null) {
      const url = imageUrl(whole[2], assetBase);
      if (url !== null) return { kind: "image", url, alt: whole[1] };
    }

    return { kind: "paragraph", spans: spansOf(line, assetBase) };
  });
}

/**
 * A body reduced to one line of text, for a preview.
 *
 * The website's `stripMd`: the syntax is removed rather than shown, so a list
 * preview reads as a sentence instead of as asterisks.
 */
export function markdownToText(source: string): string {
  return parseMarkdown(source)
    .map((block) =>
      block.kind === "image"
        ? block.alt
        : block.spans
            .map((span) => (span.kind === "image" ? span.alt : span.text))
            .join(""),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The images a body never places itself.
 *
 * The website draws these as a gallery under the briefing, and the reason is
 * the paste path: an organiser can upload an image and then delete the
 * reference to it, or upload several and place one. Anything nobody placed is
 * still theirs, so it is shown rather than orphaned.
 */
export function unplacedImages(files: string[], bodies: string[]): string[] {
  const placed = bodies.join(" ");
  return files.filter(
    (file) =>
      !placed.includes(`/desc-images/${file}`) &&
      !placed.includes(`/desc-images/${encodeURIComponent(file)}`),
  );
}
