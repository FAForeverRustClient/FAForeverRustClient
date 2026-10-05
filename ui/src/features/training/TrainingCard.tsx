// One resource, as a card: picture above, caption below.
//
// The shape is lifted from the guides grid on `feat/tutorials-guides`, and the
// reason it works there is the reason it works here: a player looking for a
// build order recognises the map long before they read its name, so a card is
// a picture with a caption rather than a paragraph with a button. The previous
// version put a kind badge, a level chip, a rating chip, a title, a summary,
// three topic tags and two buttons in every tile, which is a lot of furniture
// for something a reader is scanning twenty of.
//
// What survived that trim is what a reader actually scans on: the art, the
// title, one line under it, and a mark saying what a click costs. Everything
// else is in the detail pane, one click away, where there is room for it.
//
// The same card serves the recommendation rail and the library on purpose: a
// player who learns to read it once has learned the whole tab. What changes
// between the two places is the surrounding grid, not the card.

import { useState, type CSSProperties } from "react";
import { Icon } from "../../design-system/Icon";
import type { TrainingResource } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import { artCandidates, coverHue, kindIcon, kindLabel } from "./trainingPresentation";

interface Props {
  resource: TrainingResource;
  /** Why this card is being shown, when the rail can say. */
  reason?: string | null;
  onOpen: (resource: TrainingResource) => void;
  onSelect: (resource: TrainingResource) => void;
}

export function TrainingCard({ resource, reason, onSelect }: Props) {
  const { t } = useTranslation();
  // Whichever line adds something. A guide with no summary is usually one
  // somebody published under their own name, and that name is the caption.
  const caption = reason || resource.summary || resource.author;

  return (
    // The whole card opens the detail pane rather than the destination: the
    // detail pane is where the related entries are, which is the whole reason
    // the library is a graph and not a list. Opening the video or the page is
    // the primary action *there*, where the reader has decided.
    <button type="button" className="training-card" onClick={() => onSelect(resource)}>
      <TrainingArt resource={resource} kindMark />
      <span className="training-card-copy">
        <strong>{resource.title}</strong>
        {caption && <small className={reason ? "training-card-reason" : undefined}>{caption}</small>}
        {/* Who vouched for it, when anyone has. The one fact beyond the
            caption a card carries, because it is the one a reader weighs
            before opening anything. */}
        {resource.approvedBy && (
          <small className="training-card-reviewed">
            <Icon name="check" size={11} />
            <span>{t("training.reviewedBy", { login: resource.approvedBy })}</span>
          </small>
        )}
      </span>
    </button>
  );
}

/**
 * The picture an entry is recognised by: one frame, one shape, every time.
 *
 * Every tile is 16:9, because the two pictures this library has are different
 * shapes and a grid of two tile shapes is ragged however it is aligned. A
 * video still fills the frame. A map preview is square and is shown whole,
 * never cropped, with a blurred and dimmed copy of itself filling the sides:
 * the frame is the picture's own colours rather than a grey border.
 *
 * Whatever has no picture, or whose picture has gone (most of the library is
 * a link to somebody else's video, and a removed video answers its still with
 * a 404), gets a drawn cover: its title on a tint shared by everything from
 * the same author, so a series reads as a series on the shelf.
 *
 * Exported for the detail page's header, which shows the same picture larger.
 */
export function TrainingArt({
  resource,
  kindMark = false,
  className,
}: {
  resource: TrainingResource;
  /** The small kind glyph in the corner, for a tile scanned among others. */
  kindMark?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((store) => store.state.maps.vault);
  const candidates = artCandidates(vault, resource);
  const key = candidates.join("\n");
  // How many candidates have failed, keyed by the list they failed from: an
  // entry whose art changes underneath it starts again from the top.
  const [failed, setFailed] = useState({ key, count: 0 });
  const index = failed.key === key ? failed.count : 0;
  const picture = candidates[index] ?? "";
  const frameClass = ["training-art", className].filter(Boolean).join(" ");

  if (!picture) {
    const style = { "--cover-hue": coverHue(resource) } as CSSProperties;
    return (
      <span className={`${frameClass} is-cover`} style={style} aria-hidden>
        <span className="training-art-cover-kind">
          <Icon name={kindIcon(resource.kind)} size={13} />
          {t(kindLabel(resource.kind))}
        </span>
        <span className="training-art-cover-title">{resource.title}</span>
        {resource.author && <span className="training-art-cover-author">{resource.author}</span>}
      </span>
    );
  }

  const onError = () => setFailed({ key, count: index + 1 });
  return (
    <span className={frameClass}>
      {/* The same picture, blurred, behind it: what fills the sides of a
          square preview in a wide frame. Decoration, so it never reports a
          failure of its own. */}
      <img
        className="training-art-backdrop"
        src={picture}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
      />
      <img
        className="training-art-image"
        src={picture}
        alt=""
        loading="lazy"
        decoding="async"
        onError={onError}
      />
      {/* What a click costs, before the click. */}
      {kindMark && (
        <span className="training-card-kind" title={t(kindLabel(resource.kind))}>
          <Icon name={kindIcon(resource.kind)} size={12} />
        </span>
      )}
    </span>
  );
}
