// A translated sentence with a bold stretch or a link in it.
//
// The website writes these as HTML ("Uses your <strong>Global</strong> rating",
// "on the <a>Matches</a> tab"), and splitting such a sentence into three
// catalogue keys around the bold part would fix the word order of English on
// every other language. So the catalogue carries the marks inside one string,
// `**bold**` and `[link]`, and a translator moves them with the words.
//
// Only these two marks, and never nested: the strings are ours, not the
// organiser's, so this is not a markdown renderer and does not try to be.

export type RichPart =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string };

/** A sentence split into its plain, bold and link parts, in order. */
export function richParts(source: string): RichPart[] {
  const parts: RichPart[] = [];
  const pattern = /\*\*(.+?)\*\*|\[(.+?)\]/g;
  let at = 0;
  for (const found of source.matchAll(pattern)) {
    const start = found.index ?? 0;
    if (start > at) parts.push({ kind: "text", text: source.slice(at, start) });
    if (found[1] !== undefined) parts.push({ kind: "strong", text: found[1] });
    else parts.push({ kind: "link", text: found[2] });
    at = start + found[0].length;
  }
  if (at < source.length) parts.push({ kind: "text", text: source.slice(at) });
  return parts;
}
