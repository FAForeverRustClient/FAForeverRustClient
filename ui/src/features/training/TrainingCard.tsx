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

import { Icon } from "../../design-system/Icon";
import type { TrainingResource } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { kindIcon, kindLabel } from "./trainingPresentation";

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
      <span className="training-card-art">
        <Art resource={resource} />
        <span className="training-card-kind" title={t(kindLabel(resource.kind))}>
          <Icon name={kindIcon(resource.kind)} size={12} />
        </span>
      </span>
      <span className="training-card-copy">
        <strong>{resource.title}</strong>
        {caption && <small className={reason ? "training-card-reason" : undefined}>{caption}</small>}
      </span>
    </button>
  );
}

/**
 * Two ordered sources, and a mark when there is neither.
 *
 * The catalogue may carry a picture (a video still, a map preview); when it
 * does not, the kind mark at least says what the entry is. `contain` rather
 * than `cover` because a square map preview and a 16:9 video still share this
 * grid, and cropping either loses the thing that identifies it.
 */
function Art({ resource }: { resource: TrainingResource }) {
  if (resource.imageUrl) {
    return (
      <img
        className="training-card-image"
        src={resource.imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <span className="training-card-empty" aria-hidden>
      <Icon name={kindIcon(resource.kind)} size={20} />
    </span>
  );
}
