// What the What's new popup lists of a release: every change.
//
// A release's notes are every snippet merged since the release before it,
// grouped by category (`scripts/changelog.mjs`). The popup used to show five
// of them, the highlights when the release had them, and a count for the
// rest, so most changes reached nobody who did not open the changelog; every
// change is a line players should see, so all of them are listed now. The
// highlights (`highlights.<pr>.md`, the version-bump pull request's snippet,
// see `changelog/README.md`) lead, wherever the notes put them, and the other
// sections follow in the notes' order, each under its own heading.

import type { ChangelogBlock, ChangelogListItem } from "../../ipc/bindings";

/**
 * The heading `scripts/changelog.mjs` lists the highlights under: `Highlights`
 * in its `CATEGORIES`. A contract with that script: renamed there and not
 * here, the highlights are listed where the notes put them instead of first.
 * Kept in lower case, because a heading is compared without regard to case.
 */
export const HIGHLIGHTS_HEADING = "highlights";

export interface WhatsNewSection {
  /** The category as the notes name it, or `null` for lines before any heading. */
  heading: string | null;
  /** Its changes; a nested line stays under the one above it. Never empty. */
  items: ChangelogListItem[];
}

const isHighlights = (section: WhatsNewSection): boolean =>
  section.heading?.trim().toLowerCase() === HIGHLIGHTS_HEADING;

/**
 * Every change in a release's notes, by section, highlights first. Empty when
 * the release lists nothing (prose only, or a release from before the
 * changelog snippets).
 */
export function whatsNewSections(blocks: ChangelogBlock[]): WhatsNewSection[] {
  // The categories are the shallowest headings; a deeper one inside a
  // category (a group within the highlights, say) belongs to that category.
  const levels = blocks.flatMap((block) => (block.type === "heading" ? [block.payload.level] : []));
  const top = levels.length > 0 ? Math.min(...levels) : 0;

  const sections: WhatsNewSection[] = [];
  let current: WhatsNewSection = { heading: null, items: [] };
  for (const block of blocks) {
    if (block.type === "heading" && block.payload.level === top) {
      sections.push(current);
      current = { heading: block.payload.text.trim(), items: [] };
    } else if (block.type === "list") {
      current.items.push(...block.payload.items);
    }
  }
  sections.push(current);

  const listed = sections.filter((section) => section.items.length > 0);
  return [...listed.filter(isHighlights), ...listed.filter((section) => !isHighlights(section))];
}
