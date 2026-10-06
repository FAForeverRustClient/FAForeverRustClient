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

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { parseBlocks, renderBlock, renderSpans, type Addresses, type Block } from "./markdown";

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
  return { blocks: blocks.slice(start), source };
}

interface Section {
  id: string;
  text: string;
  /** 1 for a section, 2 for a part of one. */
  depth: 1 | 2;
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
}: {
  outline: GuideOutline;
  /**
   * Where the guide itself is read from. A picture committed beside it is
   * written relative to it, as `images/<id>/map.png`; links and rooted paths
   * still mean the page the guide was copied from.
   */
  documentUrl?: string;
}) {
  const { t } = useTranslation();
  const { blocks, source } = outline;
  const base = useMemo<Addresses>(
    () => ({ page: source ?? undefined, document: documentUrl }),
    [source, documentUrl],
  );

  // The guide's own top level, whatever it wrote it as: a guide whose
  // sections are `##` and one whose sections are `#` read the same.
  const top = useMemo(() => {
    const levels = blocks.flatMap((block) => (block.kind === "heading" ? [block.level] : []));
    return levels.length > 0 ? Math.min(...levels) : 1;
  }, [blocks]);

  const sections = useMemo<Section[]>(
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
  // A contents list of one or two entries is furniture, not navigation.
  const hasToc = sections.filter((section) => section.depth === 1).length >= 3;
  const active = useActiveSection(hasToc ? sections : []);

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    // The frame is the size container the layout below asks about: a
    // container query answers for an element's descendants, never itself.
    <div className="training-guide-frame">
    <div className={hasToc ? "training-guide has-toc" : "training-guide"}>
      <article className="training-guide-copy training-markdown">
        {hasToc && (
          <nav className="training-guide-jump" aria-label={t("training.guide.contents")}>
            {sections
              .filter((section) => section.depth === 1)
              .map((section) => (
                <button
                  type="button"
                  key={section.id}
                  className="training-guide-jump-item"
                  onClick={() => jump(section.id)}
                >
                  {section.text}
                </button>
              ))}
          </nav>
        )}
        {blocks.map((block, index) => {
          if (block.kind !== "heading") return renderBlock(block, index, base);
          // Ranked against the guide's own top level: a section, a part of
          // one, and anything deeper as a run-in label.
          const rank = Math.min(block.level - top + 1, 3);
          const Tag = rank === 1 ? "h3" : rank === 2 ? "h4" : "h5";
          return (
            <Tag
              key={index}
              id={anchorFor(block.text, index)}
              className={`training-guide-heading is-rank-${rank}`}
            >
              {renderSpans(block.text, base)}
            </Tag>
          );
        })}
      </article>

      {hasToc && (
        <nav className="training-guide-toc" aria-label={t("training.guide.contents")}>
          <p className="training-guide-toc-title">{t("training.guide.contents")}</p>
          <ol>
            {sections.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className={[
                    "training-guide-toc-item",
                    section.depth === 2 ? "is-part" : "",
                    active === section.id ? "is-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-current={active === section.id ? "location" : undefined}
                  onClick={() => jump(section.id)}
                  title={section.text}
                >
                  {section.text}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </div>
    </div>
  );
}

/**
 * The section the reader is in: the last heading that has scrolled past the
 * top of the tab.
 *
 * Read off the scroll of whatever element scrolls the guide (the tab itself),
 * on a frame rather than per event, and only while there is a contents column
 * to mark it in.
 */
function useActiveSection(sections: Section[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const frame = useRef(0);
  const ids = sections.map((section) => section.id).join(" ");

  useEffect(() => {
    if (!ids) return;
    const list = ids.split(" ");
    const first = document.getElementById(list[0]);
    const scroller = first?.closest(".training-view") ?? null;
    if (!scroller) return;
    const measure = () => {
      frame.current = 0;
      const top = scroller.getBoundingClientRect().top + 96;
      let current: string | null = list[0];
      for (const id of list) {
        const heading = document.getElementById(id);
        if (heading && heading.getBoundingClientRect().top <= top) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (frame.current === 0) frame.current = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame.current !== 0) cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [ids]);

  return active;
}
