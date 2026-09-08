/**
 * Find the links inside a run of plain text.
 *
 * For text nobody wrote as markup: a mod description, an upload note. The
 * result is runs, not HTML, so the caller renders React elements and no string
 * from the vault is ever handed to a parser.
 */

/** One run of the original text. `href` is set where the run is a link. */
export interface TextSegment {
  text: string;
  href: string | null;
}

// Only `https`, because that is the only scheme `openHttpsUrl` will open, and a
// link that is drawn and then refused is worse than text. The trailing class
// excludes the punctuation a sentence puts after a URL, so `(see https://x.dev)`
// does not link the bracket.
const URL_PATTERN = /https:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;

/**
 * Split `text` into runs, marking the HTTPS URLs in it.
 *
 * Always returns the whole input: a description is shown in full whether or not
 * it contains a link.
 */
export function linkifyText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const at = match.index ?? 0;
    if (at > cursor) segments.push({ text: text.slice(cursor, at), href: null });
    segments.push({ text: match[0], href: match[0] });
    cursor = at + match[0].length;
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), href: null });
  return segments;
}
