// The small building blocks of the generator form.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../design-system/Icon";
import { GENERATED_MAP_PLACEHOLDER_URL } from "../../shared/mapPresentation";

/** One labelled option. The label column is fixed so every control lines up. */
export function Row({
  label,
  hint,
  superseded = false,
  className,
  children,
}: {
  label: string;
  hint?: string;
  /** Dim the row: something else is deciding this value (see the style rows). */
  superseded?: boolean;
  /** Extra class, for a row whose control is taller than one field. */
  className?: string;
  children: ReactNode;
}) {
  const classes = ["generate-map-row"];
  if (superseded) classes.push("is-superseded");
  if (className) classes.push(className);
  return (
    <div className={classes.join(" ")}>
      <span className="generate-map-row-label">
        <span className="generate-map-row-label-text">{label}</span>
        {hint && <HintTip hint={hint} />}
      </span>
      <div className="generate-map-row-control">
        {children}
      </div>
    </div>
  );
}

/** Below this distance from the top of the window the tip opens downwards. */
const TIP_FLIP_BELOW = 120;
/** Half the tip's widest, so it is never pushed off either side of the window. */
const TIP_HALF_WIDTH = 140;

/**
 * The info button beside a label, with its explanation in a panel of the
 * client's own rather than the browser's grey title box.
 *
 * Portalled to the body and placed with fixed coordinates: the form scrolls
 * inside a pane that clips, and a tip on the first row would otherwise be cut
 * off at the pane's top edge.
 */
function HintTip({ hint }: { hint: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const centre = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(centre, TIP_HALF_WIDTH + 8),
      window.innerWidth - TIP_HALF_WIDTH - 8,
    );
    const below = rect.top < TIP_FLIP_BELOW;
    setPlace({ left, top: below ? rect.bottom : rect.top, below });
  };
  const hide = () => setPlace(null);

  // A scroll moves the button out from under a tip placed in fixed coordinates.
  useEffect(() => {
    if (!place) return;
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [place]);

  return (
    <span className="generate-map-hint-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="generate-map-hint-trigger"
        aria-label={hint}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <Icon name="info" size={13} />
      </button>
      {place &&
        createPortal(
          // Shown, not announced: the button already carries the text as its
          // name, and describing it by the same text would read it twice.
          <span
            aria-hidden="true"
            className={`generate-map-hint-tip${place.below ? " is-below" : ""}`}
            style={{ left: place.left, top: place.top }}
          >
            {hint}
          </span>,
          document.body,
        )}
    </span>
  );
}

export function GeneratePreviewImg({
  url,
  alt,
  className,
}: {
  url: string | undefined;
  alt: string;
  className: string;
  placeholderClassName?: string;
  iconSize?: number;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  return (
    <img
      src={!url || failed ? GENERATED_MAP_PLACEHOLDER_URL : url}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (!failed) setFailed(true);
      }}
    />
  );
}
