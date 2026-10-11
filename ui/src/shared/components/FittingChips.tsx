// A row of chips on one line that shows as many as fit and folds the rest
// into a "+N more" chip, whose tooltip lists every chip.
//
// Wrapping onto further lines made a row taller for one long lobby, and
// cutting the line off at the column's edge cut a chip through the middle.
// Which chips fit depends on the column's width, which the reader drags, so
// it is measured: on mount, whenever the chips change, and whenever the
// container is resized.

import { Children, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";

/** The chip's label for the tooltip: its own title if it has one, its text otherwise. */
function chipLabel(chip: Element): string {
  const inner = chip.firstElementChild;
  return (inner?.getAttribute("title") || chip.textContent || "").trim();
}

export function FittingChips({
  className,
  moreClassName,
  children,
}: {
  className: string;
  /** Extra classes for the "+N more" chip, so it is drawn like the others. */
  moreClassName?: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children);
  const container = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(items.length);
  const [labels, setLabels] = useState("");
  const count = items.length;

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const chips = Array.from(element.querySelectorAll<HTMLElement>(":scope > [data-chip]"));
      const moreChip = more.current;
      // Everything on screen for the measurement, then each chip shown or
      // hidden by the answer here and now, before anything is painted. The
      // state below says the same, so React leaves the styles as they are.
      for (const chip of chips) chip.style.display = "";
      if (moreChip) moreChip.style.display = "";
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const gap = parseFloat(style.columnGap) || 0;
      const available = box.width - (parseFloat(style.paddingRight) || 0);
      const moreWidth = (moreChip?.getBoundingClientRect().width ?? 0) + gap;
      const ends = chips.map((chip) => chip.getBoundingClientRect().right - box.left);
      let fit = chips.length;
      if (ends.length > 0 && ends[ends.length - 1] > available) {
        // Room has to be left for the "+N" chip itself.
        fit = ends.filter((end) => end + moreWidth <= available).length;
      }
      chips.forEach((chip, index) => {
        chip.style.display = index < fit ? "" : "none";
      });
      if (moreChip) moreChip.style.display = fit < chips.length ? "" : "none";
      setShown(fit);
      setLabels(chips.map(chipLabel).filter(Boolean).join("\n"));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // The chips are compared by how many there are: their content changes
    // re-render this component and the observer measures them again.
  }, [count]);

  const hidden = count - shown;
  return (
    <div className={className} ref={container}>
      {items.map((item, index) => (
        <span key={index} data-chip style={index < shown ? undefined : { display: "none" }}>
          {item}
        </span>
      ))}
      <i
        ref={more}
        className={moreClassName}
        title={labels}
        aria-label={labels}
        style={hidden > 0 ? undefined : { display: "none" }}
      >
        {t("lobby.browser.moreTags", { count: Math.max(hidden, 1) })}
      </i>
    </div>
  );
}
