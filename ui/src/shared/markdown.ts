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
 * Two shapes, matching what the service can produce: its own upload paths, which
 * is relative and needs the deployment's base, and an absolute `https` url.
 * `http` is refused here for a second reason beyond the one above: the desktop
 * shell's own content policy blocks it, so it could only ever render as a
 * broken image.
 */
function imageUrl(raw: string, assetBase: string): string | null {
  const url = raw.trim();
  // The FAQ / Rules articles store their pictures under `/article-images/`,
  // an event's text under `/desc-images/`: the website's own rule.
  if (/^\/(article|desc)-images\/[A-Za-z0-9_.%-]+$/.test(url)) {
    const base = assetBase.trim().replace(/\/+$/, "");
    return base === "" ? null : `${base}${url}`;
  }
  return url.startsWith("https://") && !/[<>"'\s]/.test(url) ? url : null;
}

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;
const BOLD = /\*\*([^*\n]+?)\*\*/;
const UNDERLINE = /__([^_\n]+?)__/;
// The website's own italic: a single star on each side, not half of a pair.
const ITALIC = /(?<!\*)\*([^*\n]+)\*(?!\*)/;

/** The constructs of a line, in the order the website replaces them. */
const CONSTRUCTS = [
  ["image", IMAGE],
  ["link", LINK],
  ["bold", BOLD],
  ["underline", UNDERLINE],
  ["italic", ITALIC],
] as const;

/**
 * Split one line into spans.
 *
 * Whichever construct starts first in the line is taken, and what it wraps is
 * split again. That is what the website's run of global replaces comes to:
 * there, a link is replaced before the italic around it, and the italic then
 * wraps the finished link; `__**name**__` is underlined bold. Taking a fixed
 * order here instead broke both apart and left their marks as text. On a tie
 * the website's order decides, which is what keeps `![alt](url)` an image
 * rather than a `!` and a link. Recursive on the parts rather than a global
 * replace: the website replaces into a string, which it can only do because it
 * is building one.
 */
function spansOf(line: string, assetBase: string): MarkdownSpan[] {
  if (line === "") return [];

  let first: { kind: (typeof CONSTRUCTS)[number][0]; found: RegExpExecArray } | null = null;
  for (const [kind, pattern] of CONSTRUCTS) {
    const found = pattern.exec(line);
    if (found !== null && (first === null || found.index < first.found.index)) first = { kind, found };
  }
  if (first === null) return [{ kind: "text", text: line, bold: false, italic: false, underline: false }];

  const { kind, found } = first;
  const before = spansOf(line.slice(0, found.index), assetBase);
  const after = spansOf(line.slice(found.index + found[0].length), assetBase);

  if (kind === "image") {
    const url = imageUrl(found[2], assetBase);
    // An image that cannot be resolved keeps its alt text: an organiser's
    // caption is worth more than a gap where a picture would have been.
    const span: MarkdownSpan =
      url === null
        ? { kind: "text", text: found[1], bold: false, italic: false, underline: false }
        : { kind: "image", url, alt: found[1] };
    return [...before, span, ...after];
  }

  if (kind === "link") {
    const url = linkUrl(found[2]);
    const span: MarkdownSpan =
      url === null
        ? { kind: "text", text: found[1], bold: false, italic: false, underline: false }
        : { kind: "link", text: found[1], url };
    return [...before, span, ...after];
  }

  const inner = spansOf(found[1], assetBase).map((span) =>
    span.kind === "text" ? { ...span, [kind]: true } : span,
  );
  return [...before, ...inner, ...after];
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

    // `- ` only, as on the website: `* item` is a line that starts with an
    // italic star, and `1. item` is text.
    const bullet = /^-\s+(.*)$/.exec(line);
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
