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

import { useState } from "react";
import { Icon } from "../../design-system/Icon";
import type { TrainingKind, TrainingResource } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import { kindIcon, kindLabel, mapPreviewUrl, videoThumbnailUrl } from "./trainingPresentation";

/**
 * The kinds whose picture is a video frame, and whose tile is therefore wide.
 *
 * The tile's shape follows what goes in it rather than one shape for the whole
 * grid, because the two pictures this library has are different shapes and
 * neither survives the other's box: a square map preview letterboxed into 16:9
 * carries a bar down each side, and a 16:9 still cropped to a square loses a
 * fifth off each end. A shelf of one kind is uniform, which is every shelf
 * under a kind tab; only "everything" mixes the two.
 */
const WIDE_KINDS = new Set<TrainingKind>(["video", "replayAnalysis"]);

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
  const art = useCardArt(resource);
  const wide = WIDE_KINDS.has(resource.kind);
  // Which address failed, rather than a flag saying one did. Most of this
  // library is a link to somebody else's video, and a video that has been
  // taken down answers its still with a 404: without this the tile is the
  // browser's broken-picture glyph, which is the worst thing on the shelf.
  // Remembering the address rather than the fact means a card whose art
  // changes underneath it tries the new one.
  const [broken, setBroken] = useState("");
  const picture = art && art !== broken ? art : "";

  return (
    // The whole card opens the detail pane rather than the destination: the
    // detail pane is where the related entries are, which is the whole reason
    // the library is a graph and not a list. Opening the video or the page is
    // the primary action *there*, where the reader has decided.
    <button type="button" className="training-card" onClick={() => onSelect(resource)}>
      <span className={wide ? "training-card-art is-wide" : "training-card-art"}>
        {picture ? (
          <img
            className="training-card-image"
            src={picture}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setBroken(picture)}
          />
        ) : (
          <span className="training-card-empty" aria-hidden>
            {/* Large and quiet rather than small on a slab: at this tile size
                the glyph is the tile, and half the catalogue is a link with no
                picture behind it. */}
            <Icon name={kindIcon(resource.kind)} size={40} />
          </span>
        )}
        {/* Only over a picture. On an empty tile the glyph underneath is
            already the same answer, twice the size. */}
        {picture && (
          <span className="training-card-kind" title={t(kindLabel(resource.kind))}>
            <Icon name={kindIcon(resource.kind)} size={12} />
          </span>
        )}
      </span>
      <span className="training-card-copy">
        <strong>{resource.title}</strong>
        {caption && <small className={reason ? "training-card-reason" : undefined}>{caption}</small>}
      </span>
    </button>
  );
}

/**
 * The picture a card leads with, or the empty string when there is none.
 *
 * A hook rather than a helper because the map vault it resolves against is
 * store state, and the card is the only thing that wants it.
 *
 * A build order shows its map, always, and in preference to anything the entry
 * carries: it is about one piece of ground, and the reader recognises that
 * ground long before they read the title. That is also why it never falls back
 * to a video frame even when its address is one, which seven of them are: a
 * still of somebody's face cam identifies the author, which is the one thing
 * the caption already says, and it would put a wide tile on a shelf of square
 * ones for nothing.
 *
 * Otherwise the catalogue's own picture, and failing that the frame YouTube
 * publishes for the video. Not one of the ninety entries carries an `imageUrl`
 * today, so without that last step two thirds of the library is empty tiles.
 */
function useCardArt(resource: TrainingResource): string {
  const vault = useAppStore((store) => store.state.maps.vault);
  if (resource.kind === "buildOrder") {
    return mapPreviewUrl(vault, resource.maps) || resource.imageUrl;
  }
  return resource.imageUrl || videoThumbnailUrl(resource.url);
}
