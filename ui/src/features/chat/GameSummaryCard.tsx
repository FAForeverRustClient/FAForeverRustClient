// What is known about the game a player is in, as one card.
//
// Shared deliberately. The same facts are shown in two places: floating out of
// a roster badge on hover, and standing open beside a private conversation.
// Two copies would have drifted the moment either grew a field, and the second
// place exists precisely because the first one is not always enough.

import type { SocialState, VaultMap } from "../../ipc/bindings";
import { MapThumbnail } from "../../shared/MapThumbnail";
import { openPlayerCard } from "../player-card/playerCardActions";
import { displayName } from "./chatFormat";
import { rosterRatingSummary } from "./ratingSummary";
import { flagSrc } from "../../shared/countryFlags";
import { useCountryLabel } from "../../shared/useCountryLabel";
import { formatGameTime } from "../../shared/durations";
import { mapPresentation } from "../../shared/mapPresentation";
import { gameElapsedSeconds, gameTeamSummaries, type GamePresence } from "./gameSummary";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

export const STATUS_LABEL = {
  hosting: "chat.presence.hosting",
  lobbying: "chat.presence.lobbying",
  playing: "chat.presence.playing",
  playingDelayed: "chat.presence.playingDelayed",
} as const satisfies Record<GamePresence["status"], MessageKey>;

interface Props {
  presence: GamePresence;
  social: SocialState;
  vault: VaultMap[];
  /** Seconds since the epoch, from whichever tick the caller runs. */
  now: number;
  /** Skipped by a closed popover: this is the expensive half of the card. */
  showTeams?: boolean;
  /** Drawn beside the title where the card is not already next to a badge. */
  showMap?: boolean;
  /**
   * Makes the names in the lineup behave the way a name in the roster does:
   * hover for the rating summary, click for the profile card, double-click
   * for a private conversation, right-click for the player menu.
   *
   * Optional, and absent in the popover on purpose. That card is a tooltip
   * that closes when the pointer leaves the badge it hangs off, so nothing in
   * it can be reached to be clicked; offering buttons there would be a
   * promise the surface cannot keep.
   */
  onOpenConversation?: (nickname: string) => void;
  onPlayerContextMenu?: (nickname: string, event: React.MouseEvent) => void;
}

export function GameSummaryCard({
  presence,
  social,
  vault,
  now,
  showTeams = true,
  showMap = false,
  onOpenConversation,
  onPlayerContextMenu,
}: Props) {
  const countryOf = useCountryLabel();
  const { t } = useTranslation();
  const presentation = mapPresentation(vault, presence.game.map);
  const status = t(STATUS_LABEL[presence.status]);
  const teams = showTeams ? gameTeamSummaries(presence.game, social) : [];
  const elapsed = gameElapsedSeconds(presence, now);
  // Named for what it answers rather than for the field it came from: how long
  // somebody has been playing, or how long a lobby has been sitting open.
  const elapsedLabel = presence.status === "hosting" || presence.status === "lobbying"
    ? t("chat.game.openFor")
    : t("chat.game.gameTime");

  return (
    <>
      <header className="chat-game-popover-head">
        {showMap && (
          <MapThumbnail
            mapName={presence.game.map}
            vault={vault}
            className="chat-game-card-map"
            placeholderClassName="chat-game-card-map chat-game-map-placeholder"
            preferCanonicalPreview
          />
        )}
        <div>
          <strong>{presence.game.title || t("chat.game.untitled")}</strong>
          <span>{presentation.displayName}</span>
        </div>
        <span className={`chat-game-status is-${presence.status}`}>{status}</span>
      </header>
      <div className="chat-game-meta">
        <span>{presence.game.modName.toUpperCase()}</span>
        <span>{presence.game.players}/{presence.game.maxPlayers} players</span>
        {presence.game.averageRating > 0 && <span>{presence.game.averageRating} average</span>}
        {elapsed !== null && (
          <span className="chat-game-elapsed">
            {elapsedLabel} <b>{formatGameTime(elapsed)}</b>
          </span>
        )}
      </div>
      {showTeams && (teams.length > 0 ? (
        <div className="chat-game-teams">
          {teams.map((team) => (
            <section className="chat-game-team surface" key={team.id}>
              <h4>
                <span>{team.label} ({team.players.length})</span>
                {team.rating !== null && <span>{team.rating}</span>}
              </h4>
              <ul>
                {team.players.map((player) => (
                  <li key={player.login}>
                    {player.country ? (
                      <img
                        src={flagSrc(player.country)}
                        alt={countryOf(player.country)}
                        title={countryOf(player.country)}
                        width={16}
                        height={16}
                        decoding="async"
                        draggable={false}
                        onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                      />
                    ) : <span className="chat-game-flag-placeholder" />}
                    {onPlayerContextMenu ? (
                      <button
                        type="button"
                        className="chat-game-player"
                        title={rosterRatingSummary(
                          displayName(player.login, player.profile),
                          player.profile,
                        )}
                        onClick={() => void openPlayerCard(player.profile?.id ?? null, player.login)}
                        onDoubleClick={() => onOpenConversation?.(player.login)}
                        onContextMenu={(event) => onPlayerContextMenu(player.login, event)}
                      >
                        {player.login}
                      </button>
                    ) : (
                      <span>{player.login}</span>
                    )}
                    {player.rating !== null && <small>({player.rating})</small>}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className="chat-game-no-teams muted">{t("chat.game.noLineup")}</p>
      ))}
    </>
  );
}
