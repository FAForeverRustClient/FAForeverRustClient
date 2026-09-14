// The roster's hover preview, as a card rather than an operating-system tooltip.
//
// A `title` attribute is the one surface in this client the theme cannot reach:
// the window manager draws it, in its own colours and its own font, and on a
// light desktop it arrives as a white slab over a dark roster. It was also the
// only place a player's ratings were shown on hover, which is a thing people do
// constantly while reading a channel, so it is worth the card.
//
// Positioning follows `GameSummaryPopover`, for the same reason it does: the
// roster is against the right edge of the window, so the card opens to its
// left and is clamped into the viewport rather than pushing the layout around.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlayerProfile } from "../../ipc/bindings";
import { flagSrc } from "../../shared/countryFlags";
import { useCountryLabel } from "../../shared/useCountryLabel";
import { leaderboardLabel } from "../../shared/playerRatings";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { orderedRatings } from "./ratingRows";

/** How long the pointer has to rest on a name before the card appears. */
const HOVER_DELAY_MS = 260;

/** Roughly the tallest the card gets, so the clamp below leaves room for it. */
const CARD_HEIGHT_PX = 240;

export function PlayerRatingCard({
  displayName,
  profile,
}: {
  displayName: string;
  profile: PlayerProfile | undefined;
}) {
  const { t } = useTranslation();
  const countryOf = useCountryLabel();
  const ratings = profile ? orderedRatings(profile) : [];

  return (
    <>
      <header className="chat-player-card-head">
        {profile?.avatarUrl ? (
          <img
            className="chat-player-card-avatar"
            src={profile.avatarUrl}
            alt=""
            width={40}
            height={20}
            decoding="async"
            draggable={false}
          />
        ) : null}
        {profile?.country ? (
          <img
            className="chat-flag"
            src={flagSrc(profile.country)}
            alt={countryOf(profile.country)}
            width={16}
            height={16}
            decoding="async"
            draggable={false}
            onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
          />
        ) : null}
        <strong>{displayName}</strong>
      </header>
      {!profile ? (
        <p className="chat-player-card-empty muted">{t("chat.rating.none")}</p>
      ) : ratings.length === 0 ? (
        <p className="chat-player-card-empty muted">{t("chat.rating.unrated")}</p>
      ) : (
        <dl className="chat-player-card-ratings">
          {ratings.map((rating) => (
            <div key={rating.leaderboard}>
              <dt>{leaderboardLabel(rating.leaderboard)}</dt>
              <dd>
                <b>{formatNumber(rating.rating)}</b>
                {rating.gamesPlayed > 0 && (
                  <span className="muted">
                    {t("chat.rating.games", { count: formatNumber(rating.gamesPlayed) })}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/**
 * Hover state and placement for one roster identity.
 *
 * Returned as props to spread rather than as a wrapper element: the identity is
 * a `<button>` inside a row the context menu already listens on, and wrapping it
 * would put a second box between the two.
 */
export function usePlayerRatingCard(
  displayName: string,
  profile: PlayerProfile | undefined,
): {
  cardProps: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
    "aria-describedby": string | undefined;
  };
  anchorRef: React.RefObject<HTMLButtonElement>;
  card: React.ReactNode;
} {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, right: 8 });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const cardId = useId();

  const updatePosition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    setPosition({
      top: Math.max(8, Math.min(rect.top, viewportHeight - CARD_HEIGHT_PX)),
      right: Math.max(8, viewportWidth - rect.left + 8),
    });
  }, []);

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
  }, []);

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), HOVER_DELAY_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [open, updatePosition, cancel]);

  const card = open
    ? createPortal(
      <aside id={cardId} role="tooltip" className="chat-player-card" style={position}>
        <PlayerRatingCard displayName={displayName} profile={profile} />
      </aside>,
      document.body,
    )
    : null;

  return {
    cardProps: {
      onMouseEnter: schedule,
      onMouseLeave: cancel,
      onFocus: schedule,
      onBlur: cancel,
      "aria-describedby": open ? cardId : undefined,
    },
    anchorRef,
    card,
  };
}
