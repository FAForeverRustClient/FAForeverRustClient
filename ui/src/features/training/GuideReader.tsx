// A hosted guide, read in the tab the way the changelog reads a release note.
//
// The guide used to be rendered as the editor preview renders a draft: one
// column at panel text size, its sections a point larger than its body. That
// is the right density for checking that a heading is a heading before
// posting it, and the wrong one for reading four thousand words, where the
// reader needs to see where a section starts, where they are, and how much is
// left. So a guide gets the changelog's reading surface: a reading measure, a
// generous line height, headings that rank visibly, and its sections as a
// contents column beside the text when there is room, or a row of jump links
// above it when there is not.
//
// The wiki's guides also come in tabs: a section whose parts the wiki shows
// one at a time under a row of tab labels. Laid out one under another they
// read as a run of short sections with nothing to say they belong together,
// so the reader lays them out as the wiki does.

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { parseBlocks, renderBlock, renderSpans, type Addresses, type Block } from "./markdown";
import { ReadingLayout, type ReadingSection } from "../../shared/components/ReadingLayout";

/** A guide's body, with what the page around it already says taken out. */
export interface GuideOutline {
  blocks: Block[];
  /** The page the guide was copied from, when its byline names one. */
  source: string | null;
}

/** How a guide in the catalogue repository cites where it came from. */
const ORIGINAL_LINK = /\[[^\]]*\]\((https:\/\/[^)\s]+)\)/;

/** A one-line byline with nothing else in it: "By X." or "A … by X." */
const BYLINE_ONLY = /^(an? [^.]{0,60} )?by [^.]{1,60}\.$/i;

/**
 * Split a guide into its body and the two lines the page header already says.
 *
 * Every guide in the catalogue repository opens with its own title as a `#`
 * heading and a byline ("By arma473. [The original](…)"). The page shows the
 * title in its header and the author in its facts, so both come out of the
 * body, and the link to the original moves to the header beside them. A guide
 * written differently loses nothing: only a leading `#` and a short leading
 * paragraph that is a byline (one that names an original, or one that says
 * nothing but who wrote it) are taken.
 */
export function guideOutline(markdown: string): GuideOutline {
  const blocks = parseBlocks(markdown);
  let start = 0;
  if (blocks[0]?.kind === "heading" && blocks[0].level === 1) start = 1;
  let source: string | null = null;
  const byline = blocks[start];
  if (byline?.kind === "paragraph" && byline.text.length < 240) {
    const text = byline.text.trim();
    const link = ORIGINAL_LINK.exec(text);
    if (link && /^(by |\[)/i.test(text)) {
      source = link[1];
      start += 1;
    } else if (!link && BYLINE_ONLY.test(text)) {
      // "A 1v1 build order by Sladow-Noob.": the kind, the mode and the
      // author, every one of which the header already shows.
      start += 1;
    }
  }
  return { blocks: withoutRedundantRules(blocks.slice(start)), source };
}

/**
 * The level a guide writes its sections at: the shallowest heading it has,
 * counting the tabsets it never shows, so the tabs under a top-level tabset
 * rank as parts of a section rather than as sections.
 */
function topLevel(blocks: Block[]): number {
  const levels = blocks.flatMap((block) =>
    block.kind === "heading" || block.kind === "tabset" ? [block.level] : [],
  );
  return levels.length > 0 ? Math.min(...levels) : 1;
}

/**
 * The guide's rules, less the ones that would draw a second line.
 *
 * The reader draws a hairline over every section, so a `---` its author put
 * before a section, or right under one, doubles it; two rules in a row, or one
 * at either end of the guide, separate nothing. The copied wiki guides do all
 * of these, and a reader saw two or three lines stacked between two headings.
 * A rule between two paragraphs is the author's own break and stays.
 */
function withoutRedundantRules(blocks: Block[]): Block[] {
  const top = topLevel(blocks);
  const isSection = (block: Block | undefined) =>
    block?.kind === "heading" && block.level === top;
  const kept: Block[] = [];
  blocks.forEach((block, index) => {
    if (block.kind !== "rule") {
      kept.push(block);
      return;
    }
    const before = kept[kept.length - 1];
    const after = blocks.slice(index + 1).find((next) => next.kind !== "rule");
    if (before === undefined || after === undefined) return;
    if (before.kind === "rule" || isSection(before) || isSection(after)) return;
    kept.push(block);
  });
  return kept;
}

/** A block and where it stands in the guide, which is what its key and anchor are. */
export interface Placed {
  block: Block;
  index: number;
}

/** One tab: its heading, which becomes the label, and the text under it. */
export interface GuideTab {
  heading: Placed & { block: Extract<Block, { kind: "heading" }> };
  body: Placed[];
}

/** The guide as the reader lays it out: blocks, and runs of them shown as tabs. */
export type GuideSegment =
  | { kind: "block"; placed: Placed }
  | { kind: "tabs"; index: number; lead: Placed[]; tabs: GuideTab[] };

/**
 * Group a guide's tabsets into tabs, the way the wiki shows them.
 *
 * A tabset at level n takes everything after it up to the next heading at
 * level n or above. Each heading one level deeper inside it starts a tab and
 * names it; anything before the first of those stays above the tabs. A tabset
 * with no headings under it has nothing to tab between, so its text is laid
 * out as it would be without it.
 */
export function guideSegments(blocks: Block[]): GuideSegment[] {
  const segments: GuideSegment[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index];
    if (block.kind !== "tabset") {
      segments.push({ kind: "block", placed: { block, index } });
      index += 1;
      continue;
    }
    const at = index;
    const lead: Placed[] = [];
    const tabs: GuideTab[] = [];
    index += 1;
    while (index < blocks.length) {
      const inner = blocks[index];
      const ends =
        (inner.kind === "heading" || inner.kind === "tabset") && inner.level <= block.level;
      if (ends) break;
      if (inner.kind === "heading" && inner.level === block.level + 1) {
        tabs.push({ heading: { block: inner, index }, body: [] });
      } else if (tabs.length > 0) {
        tabs[tabs.length - 1].body.push({ block: inner, index });
      } else {
        lead.push({ block: inner, index });
      }
      index += 1;
    }
    if (tabs.length === 0) {
      for (const placed of lead) segments.push({ kind: "block", placed });
    } else {
      segments.push({ kind: "tabs", index: at, lead, tabs });
    }
  }
  return segments;
}

/** A heading's anchor: its words, and its position so two "Notes" differ. */
function anchorFor(text: string, index: number): string {
  const words = text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `guide-${index}-${words}`.slice(0, 80);
}

/** The heading text as a reader sees it in a list: no markup, no icons. */
function plainHeading(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

export function GuideReader({
  outline,
  documentUrl,
  local,
}: {
  outline: GuideOutline;
  /**
   * Where the guide itself is read from. A picture committed beside it is
   * written relative to it, as `images/<id>/map.png`; links and rooted paths
   * still mean the page the guide was copied from.
   */
  documentUrl?: string;
  /** Pictures attached to a guide still being written, by the path it writes. */
  local?: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  const { blocks, source } = outline;
  const base = useMemo<Addresses>(
    () => ({ page: source ?? undefined, document: documentUrl, local }),
    [source, documentUrl, local],
  );

  // The guide's own top level, whatever it wrote it as: a guide whose
  // sections are `##` and one whose sections are `#` read the same.
  const top = useMemo(() => topLevel(blocks), [blocks]);
  const segments = useMemo(() => guideSegments(blocks), [blocks]);

  // Which tabset each tab's anchor belongs to, and which tab it is, so the
  // contents list can open a tab rather than scroll to a heading it hid.
  const tabOf = useMemo(() => {
    const map = new Map<string, { tabset: number; tab: number }>();
    for (const segment of segments) {
      if (segment.kind !== "tabs") continue;
      segment.tabs.forEach((tab, position) => {
        map.set(anchorFor(tab.heading.block.text, tab.heading.index), {
          tabset: segment.index,
          tab: position,
        });
      });
    }
    return map;
  }, [segments]);
  // The open tab of each tabset, kept with the guide it was chosen in so
  // another guide opens on its first tabs rather than on this one's choice.
  const [choice, setChoice] = useState<{ of: Block[]; tabs: Record<number, number> }>({
    of: blocks,
    tabs: {},
  });
  const chosen = choice.of === blocks ? choice.tabs : {};
  const setChosen = (update: (current: Record<number, number>) => Record<number, number>) =>
    setChoice((previous) => ({
      of: blocks,
      tabs: update(previous.of === blocks ? previous.tabs : {}),
    }));

  const sections = useMemo<ReadingSection[]>(
    () =>
      blocks.flatMap((block, index) =>
        block.kind === "heading" && block.level <= top + 1
          ? [
              {
                id: anchorFor(block.text, index),
                text: plainHeading(block.text),
                depth: block.level === top ? (1 as const) : (2 as const),
              },
            ]
          : [],
      ),
    [blocks, top],
  );

  const jump = (id: string) => {
    const tab = tabOf.get(id);
    if (tab) setChosen((current) => ({ ...current, [tab.tabset]: tab.tab }));
    // After the tab is open, so the scroll lands on what is now shown, and
    // for a tab on its card's top edge: a label in a second row of them would
    // otherwise scroll the first row out of sight.
    requestAnimationFrame(() => {
      const target = document.getElementById(id);
      (tab ? target?.closest(".training-guide-tabs") : target)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };

  const heading = (placed: Placed): ReactNode => {
    if (placed.block.kind !== "heading") return null;
    // Ranked against the guide's own top level: a section, a part of one,
    // and anything deeper as a run-in label.
    const rank = Math.min(placed.block.level - top + 1, 3);
    const Tag = rank === 1 ? "h3" : rank === 2 ? "h4" : "h5";
    return (
      <Tag
        key={placed.index}
        id={anchorFor(placed.block.text, placed.index)}
        className={`reading-heading is-rank-${rank}`}
      >
        {renderSpans(placed.block.text, base)}
      </Tag>
    );
  };
  const render = (placed: Placed): ReactNode =>
    placed.block.kind === "heading" ? heading(placed) : renderBlock(placed.block, placed.index, base);

  return (
    <ReadingLayout
      sections={sections}
      contentsLabel={t("training.guide.contents")}
      className="training-markdown"
      onJump={jump}
      layoutKey={JSON.stringify(chosen)}
    >
      {segments.map((segment) =>
        segment.kind === "block" ? (
          render(segment.placed)
        ) : (
          <GuideTabs
            key={`tabs-${segment.index}`}
            segment={segment}
            selected={chosen[segment.index] ?? 0}
            onSelect={(tab) => setChosen((current) => ({ ...current, [segment.index]: tab }))}
            render={render}
            base={base}
          />
        ),
      )}
    </ReadingLayout>
  );
}

/**
 * A tabset: the labels in a row, the chosen tab's text under them.
 *
 * The labels are the tab headings themselves and carry their anchors, so the
 * contents list and a link into the guide both land on the row. Every panel is
 * rendered and the others hidden, which keeps their pictures loading and
 * their text findable with the browser's search once opened. The arrow keys,
 * Home and End move between tabs, as the ARIA tabs pattern has them.
 */
function GuideTabs({
  segment,
  selected,
  onSelect,
  render,
  base,
}: {
  segment: Extract<GuideSegment, { kind: "tabs" }>;
  selected: number;
  onSelect: (tab: number) => void;
  render: (placed: Placed) => ReactNode;
  base: Addresses;
}) {
  const list = useRef<HTMLDivElement>(null);
  const current = Math.min(selected, segment.tabs.length - 1);
  const panelId = (tab: number) => `guide-tabs-${segment.index}-${tab}`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // From the label that has focus rather than from the render's choice: two
    // presses inside one frame would otherwise both start from the same tab.
    const labels = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const from = labels.indexOf(event.target as HTMLButtonElement);
    const at = from === -1 ? current : from;
    const last = segment.tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? at === last ? 0 : at + 1
        : event.key === "ArrowLeft"
          ? at === 0 ? last : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    onSelect(next);
    labels[next]?.focus();
  };

  return (
    <>
      {segment.lead.map(render)}
      <section className="training-guide-tabs">
        <div className="training-guide-tablist" role="tablist" ref={list} onKeyDown={onKeyDown}>
          {segment.tabs.map((tab, position) => (
            <button
              type="button"
              role="tab"
              key={tab.heading.index}
              id={anchorFor(tab.heading.block.text, tab.heading.index)}
              className="training-guide-tab"
              aria-selected={position === current}
              aria-controls={panelId(position)}
              tabIndex={position === current ? 0 : -1}
              onClick={() => onSelect(position)}
            >
              {renderSpans(tab.heading.block.text, base)}
            </button>
          ))}
        </div>
        {segment.tabs.map((tab, position) => (
          <div
            key={tab.heading.index}
            id={panelId(position)}
            role="tabpanel"
            className="training-guide-tabpanel"
            aria-labelledby={anchorFor(tab.heading.block.text, tab.heading.index)}
            hidden={position !== current}
          >
            {tab.body.map(render)}
          </div>
        ))}
      </section>
    </>
  );
}
