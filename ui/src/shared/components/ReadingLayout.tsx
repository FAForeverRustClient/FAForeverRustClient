// The client's reading surface: long text at a reading measure, its sections
// as a contents column beside it when there is room, or a row of jump links
// above it when there is not.
//
// Made for the training tab's guides, and shared because a guide is not the
// only long read in the client: the leaderboard's page on how ratings work is
// one too, and it should read the way a guide does rather than in a second
// style of its own. Everything inside the article is the caller's; this owns
// the frame, the measure, the headings' ranks (by class, `reading-heading
// is-rank-1` to `-3`) and the navigation.

import { useEffect, useRef, useState, type ReactNode } from "react";
import "./reading-layout.css";

export interface ReadingSection {
  /** The id of the heading the entry jumps to. */
  id: string;
  text: string;
  /** A section, or a part of one, which the contents indent. */
  depth: 1 | 2;
}

interface ReadingLayoutProps {
  sections: ReadingSection[];
  /** The contents' accessible name and visible title. */
  contentsLabel: string;
  children: ReactNode;
  /** Extra classes for the article, such as a markdown renderer's own. */
  className?: string;
  /**
   * Called instead of the default scroll, for a caller that has to open
   * something before the heading can be scrolled to (a guide's tabs).
   */
  onJump?: (id: string) => void;
  /**
   * Anything that changes which headings are shown without changing the
   * sections, so the section being read is measured again.
   */
  layoutKey?: string;
}

/** A contents list of one or two entries is furniture, not navigation. */
const MIN_SECTIONS = 3;

export function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function ReadingLayout({
  sections,
  contentsLabel,
  children,
  className,
  onJump = scrollToSection,
  layoutKey = "",
}: ReadingLayoutProps) {
  const hasToc = sections.filter((section) => section.depth === 1).length >= MIN_SECTIONS;
  const active = useActiveSection(hasToc ? sections : [], layoutKey);

  return (
    // The frame is the size container the layout below asks about: a
    // container query answers for an element's descendants, never itself.
    <div className="reading-frame">
      <div className={hasToc ? "reading has-toc" : "reading"}>
        <article className={className ? `reading-copy ${className}` : "reading-copy"}>
          {hasToc && (
            <nav className="reading-jump" aria-label={contentsLabel}>
              {sections
                .filter((section) => section.depth === 1)
                .map((section) => (
                  <button
                    type="button"
                    key={section.id}
                    className="reading-jump-item"
                    onClick={() => onJump(section.id)}
                  >
                    {section.text}
                  </button>
                ))}
            </nav>
          )}
          {children}
        </article>

        {hasToc && (
          <nav className="reading-toc" aria-label={contentsLabel}>
            <p className="reading-toc-title">{contentsLabel}</p>
            <ol>
              {sections.map((section) => (
                <li key={section.id}>
                  <button
                    type="button"
                    className={[
                      "reading-toc-item",
                      section.depth === 2 ? "is-part" : "",
                      active === section.id ? "is-active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-current={active === section.id ? "location" : undefined}
                    onClick={() => onJump(section.id)}
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

/** The nearest ancestor that scrolls, which is where the reader scrolls. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * The section whose heading has most recently passed the top of the
 * scroller, for the contents to mark.
 *
 * Measured on scroll, at most once a frame, rather than with an
 * IntersectionObserver: what is wanted is the last heading above a line, and
 * an observer reports headings entering and leaving, which leaves the gap
 * between two headings with no answer. A heading on a tab that is not open
 * (`aria-selected="false"`) is passed over.
 */
function useActiveSection(sections: ReadingSection[], layoutKey: string): string | null {
  const [active, setActive] = useState<string | null>(null);
  const frame = useRef(0);
  const ids = sections.map((section) => section.id).join(" ");

  useEffect(() => {
    if (!ids) return;
    const list = ids.split(" ");
    const first = document.getElementById(list[0]);
    const scroller = first ? scrollerOf(first) : null;
    if (!scroller) return;
    const measure = () => {
      frame.current = 0;
      const top = scroller.getBoundingClientRect().top + 96;
      let current: string | null = list[0];
      for (const id of list) {
        const heading = document.getElementById(id);
        if (!heading || heading.getAttribute("aria-selected") === "false") continue;
        if (heading.getBoundingClientRect().top <= top) current = id;
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
  }, [ids, layoutKey]);

  return active;
}
