// Which of a release's changes the What's new popup lists.
//
// A release's notes are every snippet merged since the release before it, by
// category and then by pull request: 88 lines for 0.9.0. The first few of
// those are the oldest pull requests' features, which says little about the
// release. So a release that leads with highlights (`highlights.<pr>.md`, the
// version-bump pull request's snippet, see `changelog/README.md`) is summed up
// by those, and everything else is a count; a release without them falls back
// to its first few lines and how many more there are.

import type { ChangelogBlock, ChangelogListItem } from "../../ipc/bindings";

/**
 * The heading `scripts/changelog.mjs` lists the highlights under: `Highlights`
 * in its `CATEGORIES`. A contract with that script: renamed there and not
 * here, every release falls back to its first few lines. Kept in lower case,
 * because a heading is compared without regard to case. It is matched, never
 * shown, so it is not a translatable string either.
 */
export const HIGHLIGHTS_HEADING = "highlights";

/** As many changes as a glance takes in; the changelog has the rest. */
export const MAX_CHANGES = 5;

export interface WhatsNewChanges {
  /** What the popup lists, at most {@link MAX_CHANGES}. Empty when the release lists nothing. */
  shown: ChangelogListItem[];
  /** Whether `shown` is the release's highlights rather than its first lines. */
  highlights: boolean;
  /**
   * The changes left out. Under highlights, every change in the other
   * sections (the highlights restate some of those, so they are not counted
   * again); otherwise the lines after the first few.
   */
  rest: number;
}

/** A block's heading level, or `null` for a block that is not a heading. */
const headingLevel = (block: ChangelogBlock): number | null =>
  block.type === "heading" ? block.payload.level : null;

const isHighlightsHeading = (block: ChangelogBlock): boolean =>
  block.type === "heading" && block.payload.text.trim().toLowerCase() === HIGHLIGHTS_HEADING;

/** Every top-level list item in `blocks`, in order. Nested items belong to their parent line. */
const listItems = (blocks: ChangelogBlock[]): ChangelogListItem[] =>
  blocks.flatMap((block) => (block.type === "list" ? block.payload.items : []));

/** What the popup shows of a release with these notes, and what it counts. */
export function whatsNewChanges(blocks: ChangelogBlock[]): WhatsNewChanges {
  const start = blocks.findIndex(isHighlightsHeading);
  if (start >= 0) {
    // The section runs to the next heading at its own level or above.
    const level = headingLevel(blocks[start]) ?? 0;
    const next = blocks.findIndex((block, index) => index > start && (headingLevel(block) ?? Infinity) <= level);
    const end = next < 0 ? blocks.length : next;
    const highlights = listItems(blocks.slice(start + 1, end));
    // A highlights heading with no lines under it says nothing; the release's
    // own lines say more.
    if (highlights.length > 0) {
      const others = listItems([...blocks.slice(0, start), ...blocks.slice(end)]);
      return { shown: highlights.slice(0, MAX_CHANGES), highlights: true, rest: others.length };
    }
  }
  const changes = listItems(blocks);
  const shown = changes.slice(0, MAX_CHANGES);
  return { shown, highlights: false, rest: changes.length - shown.length };
}
