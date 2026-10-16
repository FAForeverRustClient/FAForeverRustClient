// The overview's shape while the profile loads.
//
// The card is as tall as the tab it shows. Opened on a sentence ("Loading
// profile…"), it was a short strip that grew to its full height when the
// profile arrived, and everything in it moved. The skeleton is laid out with
// the overview's own classes (the rating tiles, the two columns of cards), so
// the card opens at about the height it keeps. The sentence stays, for screen
// readers, as the placeholder's status.

import type { CSSProperties } from "react";
import { useTranslation } from "../../i18n/useTranslation";

/** Heights of the overview's usual cards: factions, note, clan, account. */
const CARD_HEIGHTS = [156, 116, 96, 132];

export function ProfileSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="player-overview player-card-skeleton">
      <p className="player-card-skeleton-status" role="status">{t("playerCard.profileLoading")}</p>
      <section className="player-overview-section" aria-hidden>
        <span className="player-card-skeleton-line is-title" />
        <div className="player-queue-grid" style={{ "--queue-columns": 4 } as CSSProperties}>
          {[0, 1, 2, 3].map((tile) => (
            <div key={tile} className="player-queue-tile surface-panel player-card-skeleton-tile">
              <span className="player-card-skeleton-line is-short" />
              <span className="player-card-skeleton-line is-figure" />
              <span className="player-card-skeleton-line" />
            </div>
          ))}
        </div>
      </section>
      <div className="player-overview-cards" aria-hidden>
        {CARD_HEIGHTS.map((height, card) => (
          <section
            key={card}
            className="player-overview-card surface-panel player-card-skeleton-card"
            style={{ height }}
          >
            <span className="player-card-skeleton-line is-short" />
            <span className="player-card-skeleton-line" />
            <span className="player-card-skeleton-line is-short" />
          </section>
        ))}
      </div>
    </div>
  );
}
