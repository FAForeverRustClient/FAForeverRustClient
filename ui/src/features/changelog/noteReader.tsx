// The parts of the Changelog's reading surface its two sections share: the
// game patches and the client's own releases are read the same way, so they
// take their contents column, their jump row and the scrolling that ties
// those to the note from one place, and read as one tab.
//
// The sections of a note are its headings and its units. They sit in a column
// beside the note when the surface is wide enough to have room for one, and as
// a row of jump links above it when it is not (see `changelog.css`).

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChangelogBlock } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { ChangelogBlockView } from "../../shared/components/ChangelogBlocks";

/** A section of the open note, as the contents list and the jump row name it. */
export interface Section {
  id: string;
  text: string;
  /** Section, tier, unit group and unit. Deeper source levels share the last indent. */
  depth: 1 | 2 | 3 | 4;
  /**
   * The icon a unit's section opens with, for its entry in the contents. A
   * header naming a whole family gives its first unit's: the family's icons
   * differ mostly by faction, and a row of them is noise at this size.
   */
  iconUrl?: string;
}

export const anchorFor = (index: number) => `changelog-block-${index}`;

/** A heading that only names a faction, as 3775 labels each faction's units. */
const FACTION_LABEL = /^(aeon|uef|cybran|seraphim|sera|nomads?)$/i;

const compact = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const contentsDepth = (depth: number) => Math.max(1, Math.min(4, depth)) as Section["depth"];

/**
 * The sections of a note: its section, tier and group headings and its units.
 * `skipFirst` leaves out the first block when it has become the page title.
 *
 * Inside an original balance section, which renders a level lower, the cutoff
 * follows the source hierarchy: there it groups units, 3761's
 * "Frigates" or "Cruisers", and many of those units are named only by
 * faction, so without the group the contents read "Aeon, Cybran, Aeon". Left
 * out are a faction label (3775), a source date, and a label naming one unit
 * of the header it sits under, such as "Stinger" under "Stinger & Vulthoo".
 */
export function noteSections(
  blocks: ChangelogBlock[], skipFirst: boolean, historicalLabel: string, headingOffset = 0,
): Section[] {
  const sections: Section[] = [];
  let unitName = "";
  let groupDepth = headingOffset;
  blocks.forEach((block, index) => {
    if (skipFirst && index === 0) return;
    if (block.type === "historicalBalance") {
      const id = anchorFor(index);
      sections.push({ id, text: historicalLabel, depth: contentsDepth(headingOffset + 1) }, ...noteSections(block.payload.blocks, false, historicalLabel, headingOffset + 1)
        .map(section => ({ ...section, id: `${id}-${section.id.slice("changelog-block-".length)}` })));
      return;
    }
    if (block.type === "heading") {
      const { level: sourceLevel, text } = block.payload;
      if (sourceLevel <= 2) unitName = "";
      const nested = headingOffset > 0;
      const label = nested && (
        /^\s*date\s*:/i.test(text)
        || FACTION_LABEL.test(text.trim())
        || (unitName !== "" && compact(text) !== "" && unitName.includes(compact(text)))
      );
      if (sourceLevel <= 4 && !label) {
        unitName = "";
        groupDepth = Math.max(1, sourceLevel + headingOffset - 1);
        sections.push({ id: anchorFor(index), text, depth: contentsDepth(groupDepth) });
      }
      return;
    }
    if (block.type === "unit") {
      unitName = compact(block.payload.name);
      sections.push({ id: anchorFor(index), text: block.payload.name, depth: contentsDepth(Math.max(2, groupDepth + 1)), iconUrl: block.payload.units[0]?.iconUrl });
    }
  });
  return sections;
}

/**
 * The selected row kept in view, whichever way it was chosen: a click, the
 * arrow keys, or the newer and older buttons over the note. By hand, on the
 * list alone: `scrollIntoView` also scrolls every container around the list,
 * and the first selection, which lands as the tab loads, could nudge the whole
 * page. The top allowance keeps the row clear of a sticky year heading.
 */
export function keepCurrentRowInView(list: HTMLElement | null) {
  const row = list?.querySelector<HTMLElement>(".changelog-release[aria-current='page']");
  if (!list || !row) return;
  const bounds = list.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  if (rect.top < bounds.top + 36) list.scrollTop -= bounds.top + 36 - rect.top;
  else if (rect.bottom > bounds.bottom) list.scrollTop += rect.bottom - bounds.bottom;
}

/**
 * The note's scroll and the contents that follow it.
 *
 * `selection` names the note on screen: a new one opens at its top and at its
 * first section.
 */
export function useNoteContents(sections: Section[], selection: string) {
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const isClickScrolling = useRef(false);
  const clickScrollTimeout = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickScrollTimeout.current) clearTimeout(clickScrollTimeout.current);
    };
  }, []);

  // A new note opens at its top at once, not after a long smooth scroll.
  // Keyed on the selection alone: keyed on the section list too, any store
  // update that rebuilt the list threw the reader back to the top, and cut
  // short a jump that was still gliding.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
    setActiveSectionId(null);
  }, [selection]);

  // The first section is the current one until the reader moves, and a
  // rebuilt list keeps the current one if it still has it.
  useEffect(() => {
    setActiveSectionId((current) =>
      current && sections.some((section) => section.id === current) ? current : sections[0]?.id ?? null,
    );
  }, [sections]);

  // The contents column scrolls on its own when a note has many units, and
  // follows the reader so the highlighted entry never leaves it. By hand,
  // on the column alone: `scrollIntoView` scrolls every scrollable ancestor,
  // and the column sits inside the note's scroll, so it cancelled the smooth
  // scroll a click on an entry had just started.
  useEffect(() => {
    const nav = tocRef.current;
    const item = nav?.querySelector<HTMLElement>(".changelog-toc-item.is-active");
    if (!nav || !item) return;
    const bounds = nav.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.bottom > bounds.bottom) nav.scrollTop += rect.bottom - bounds.bottom + 8;
    else if (rect.top < bounds.top) nav.scrollTop -= bounds.top - rect.top + 8;
  }, [activeSectionId]);

  // Both kept stable for the memoized contents column: a new function on
  // every render redrew its whole list each time the reader scrolled.
  const onNoteScroll = useCallback(() => {
    if (isClickScrolling.current) return;
    const container = scrollRef.current;
    if (!container || sections.length === 0) return;
    if (container.scrollHeight - container.scrollTop - container.clientHeight <= 24) {
      setActiveSectionId(sections[sections.length - 1].id);
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    let currentId = sections[0].id;
    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (!element) continue;
      if (element.getBoundingClientRect().top - containerTop <= 72) currentId = section.id;
      else break;
    }
    setActiveSectionId(currentId);
  }, [sections]);

  const jumpTo = useCallback((id: string) => {
    setActiveSectionId(id);
    isClickScrolling.current = true;
    if (clickScrollTimeout.current) clearTimeout(clickScrollTimeout.current);
    clickScrollTimeout.current = window.setTimeout(() => {
      isClickScrolling.current = false;
    }, 800);
    const element = document.getElementById(id);
    const container = scrollRef.current;
    if (!element || !container) return;
    const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    // Smooth or instant per the stylesheet's `scroll-behavior`, which
    // honours a request for reduced motion.
    container.scrollTo({ top: Math.max(0, container.scrollTop + offset - 16) });
  }, []);

  return { scrollRef, tocRef, activeSectionId, onNoteScroll, jumpTo };
}

/**
 * The note itself, drawn again only when the note changes. The view around it
 * redraws on every keystroke in the release filter and every time the current
 * section changes while scrolling, and a long note redrawn with it (3761's
 * original balance notes are close to 300 blocks) made both lag.
 */
export const NoteBlocks = memo(function NoteBlocks({ blocks, skipFirst = false }: {
  blocks: ChangelogBlock[];
  skipFirst?: boolean;
}) {
  return (
    <>
      {blocks.map((block, index) =>
        skipFirst && index === 0 ? null : (
          <ChangelogBlockView key={index} block={block} anchorId={anchorFor(index)} />
        ),
      )}
    </>
  );
});

/**
 * The sections as a row of jump links, for a surface too narrow for the
 * contents column. Only the top level: units are many, and a wrapped row of
 * thirty names is not a way to find one.
 */
export function NoteJumpRow({ sections, onJump }: { sections: Section[]; onJump: (id: string) => void }) {
  const { t } = useTranslation();
  const topSections = sections.filter((section) => section.depth === 1);
  if (topSections.length <= 1) return null;
  return (
    <nav className="changelog-jump" aria-label={t("changelog.contents")}>
      {topSections.map((section) => (
        <button
          key={section.id}
          type="button"
          className="changelog-jump-item"
          onClick={() => onJump(section.id)}
        >
          {section.text}
        </button>
      ))}
    </nav>
  );
}

/**
 * The contents column beside the note, when the surface has room for it.
 * Memoized like the note: a long patch lists over a hundred entries here.
 */
export const NoteContentsColumn = memo(function NoteContentsColumn({
  sections,
  activeSectionId,
  navRef,
  onJump,
}: {
  sections: Section[];
  activeSectionId: string | null;
  navRef: RefObject<HTMLElement>;
  onJump: (id: string) => void;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => {
    type Branch = { section: Section; children: Branch[] };
    const roots: Branch[] = [];
    const parents: Branch[] = [];
    for (const section of sections) {
      while (parents.length && parents[parents.length - 1].section.depth >= section.depth) parents.pop();
      const branch: Branch = { section, children: [] };
      (parents[parents.length - 1]?.children ?? roots).push(branch);
      parents.push(branch);
    }
    return roots;
  }, [sections]);
  if (sections.length === 0) return null;
  const item = ({ section, children }: (typeof tree)[number]): ReactNode => (
    <li key={section.id}>
      <button
        type="button"
        className={`changelog-toc-item depth-${section.depth}${section.iconUrl ? " has-icon" : ""}${children.length ? " is-group" : ""}${
          activeSectionId === section.id ? " is-active" : ""
        }`}
        aria-current={activeSectionId === section.id ? "location" : undefined}
        title={section.depth > 1 ? section.text : undefined}
        onClick={() => onJump(section.id)}
      >
        {section.iconUrl ? <>
          <img className="changelog-toc-icon" src={section.iconUrl} alt="" loading="lazy" draggable={false}
            onError={(event) => event.currentTarget.classList.add("is-missing")} />
          <span className="changelog-toc-text">{section.text}</span>
        </> : section.text}
      </button>
      {children.length > 0 && <ul className="changelog-toc-children">{children.map(item)}</ul>}
    </li>
  );
  return (
    <nav className="changelog-toc" ref={navRef} aria-label={t("changelog.contents")}>
      <p className="changelog-toc-title">{t("changelog.contents")}</p>
      <ul className="changelog-toc-list">
        {tree.map(item)}
      </ul>
    </nav>
  );
});
