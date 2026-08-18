// A FAF player as a name, an avatar and a rating.
//
// The whole reason entrants carry a `fafPlayerId`: with it, a row in a bracket
// is a person the client knows things about. Without it, it is a string, which
// is what every FAF tournament tool has shown until now.

import type { PlayerSummary } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

interface PlayerChipProps {
  player: PlayerSummary;
  /** Shown instead of the account's login, when an entry was named differently. */
  overrideName?: string;
}

export function PlayerChip({ player, overrideName }: PlayerChipProps) {
  const { t } = useTranslation();
  const rating = player.globalRating ?? player.ladderRating;

  return (
    <span className="player-chip">
      {player.avatarUrl ? (
        <img
          className="player-chip-avatar"
          src={player.avatarUrl}
          alt=""
          loading="lazy"
          // Decorative: the name beside it already identifies the player, so a
          // screen reader announcing the avatar's file name would only repeat
          // less useful information.
          aria-hidden
        />
      ) : (
        <span className="player-chip-avatar is-empty" aria-hidden />
      )}
      <span className="player-chip-name">{overrideName ?? player.login}</span>
      {rating !== null && (
        <span className="player-chip-rating muted" title={t("tournaments.entrants.rating")}>
          {rating}
        </span>
      )}
    </span>
  );
}
