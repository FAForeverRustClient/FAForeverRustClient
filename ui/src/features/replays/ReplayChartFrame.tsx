// A chart with a caption and a way to see it big.
//
// Every picture in the replay analysis is the same shape: a title, a drawing,
// and sometimes a legend under it. In a panel that holds four of them at once
// the drawing is a few hundred pixels wide, which is enough to see the shape
// of a thing and not enough to read the numbers on it -- "man kann nichts
// erkennen weil die windows zu klein sind". Pressing the caption's button
// gives the chart the whole viewport, and pressing it again gives it back.
//
// The contents are rendered in one place at a time rather than in both: the
// heatmap draws onto a canvas it holds a ref to, and two live copies of that
// would leave the ref pointing at whichever mounted last.

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";

export function ReplayChartFrame({
  title,
  zoomed,
  onZoom,
  className = "",
  legend,
  children,
}: {
  title: string;
  /** Whether this chart is the one filling the viewport. */
  zoomed: boolean;
  /** `true` to open it, `false` to put it back. */
  onZoom: (zoomed: boolean) => void;
  className?: string;
  /** The key under the drawing, which travels with it into the overlay. */
  legend?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  // On `window`, in the capture phase, and only while this chart is open.
  //
  // The panel around this one closes itself on Escape from a capture-phase
  // listener on `document`. Capture runs outwards in, so a listener on
  // `window` is reached first and can stop the event before the panel behind
  // sees it: one press steps out of the enlarged chart, the next closes the
  // panel. A second `document` listener could not do that -- two listeners on
  // the same target run in the order they were added, and the panel was there
  // first.
  useEffect(() => {
    if (!zoomed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onZoom(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onZoom, zoomed]);

  const body = (
    <>
      <div className="replay-chart-frame-body">{children}</div>
      {legend}
    </>
  );

  return (
    <figure className={`replay-chart-frame ${className}`.trim()}>
      <figcaption>
        <span className="replay-chart-frame-title" title={title}>{title}</span>
        <button
          type="button"
          className="replay-card-icon-btn"
          aria-label={t("replays.insights.enlargeChart", { name: title })}
          title={t("replays.insights.enlargeChart", { name: title })}
          onClick={() => onZoom(true)}
        >
          <Icon name="search" size={13} />
        </button>
      </figcaption>
      {zoomed
        ? <p className="replay-chart-frame-away muted">{t("replays.insights.chartEnlarged")}</p>
        : body}
      {zoomed && createPortal(
        <div className="replay-preview-scrim" role="presentation" onClick={() => onZoom(false)}>
          <div
            className="replay-chart-zoom"
            role="dialog"
            aria-label={title}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="replay-chart-zoom-head">
              <h3>{title}</h3>
              <button
                type="button"
                className="replay-card-icon-btn"
                aria-label={t("replays.insights.close")}
                title={t("replays.insights.close")}
                onClick={() => onZoom(false)}
              >
                <Icon name="close" size={15} />
              </button>
            </header>
            <div className="replay-chart-zoom-body">{body}</div>
          </div>
        </div>,
        document.body,
      )}
    </figure>
  );
}
