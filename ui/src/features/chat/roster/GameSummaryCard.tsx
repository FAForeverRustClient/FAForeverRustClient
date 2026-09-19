// What is known about the game a player is in, as one card.
//
// Shared deliberately. The same facts are shown in two places: floating out of
// a roster badge on hover, and standing open beside a private conversation.
// Two copies would have drifted the moment either grew a field, and the second
// place exists precisely because the first one is not always enough.

import type { SocialState, VaultMap } from "../../../ipc/bindings";
import { Icon } from "../../../design-system/Icon";
import { MapThumbnail } from "../../../shared/components/MapThumbnail";
import { openPlayerCard } from "../../../shared/playerCardActions";
import { GLOBAL_LEADERBOARD, gameLeaderboard, leaderboardLabel } from "../../../shared/playerRatings";
import { useNamedMapGeneration } from "../../../shared/hooks/useNamedMapGeneration";
import { displayName } from "../messages/chatFormat";
import { usePlayerRatingCard } from "./PlayerRatingCard";
import { flagSrc } from "../../../shared/countryFlags";
import { useCountryLabel } from "../../../shared/hooks/useCountryLabel";
import { formatGameTime } from "../../../shared/format/durations";
import { mapPresentation } from "../../../shared/mapPresentation";
import {
  gameElapsedSeconds,
  gameTeamSummaries,
  type GamePresence,
  type GameSummaryPlayer,
} from "./gameSummary";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";

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
   * Makes the names in the lineup clickable: profile card on a click, private
   * conversation on a double click, player menu on a right click.
   *
   * Optional, and absent where the lineup has nowhere to host a menu. The
   * rating card on hover is offered either way, since it is not a control.
   */
  onOpenConversation?: (nickname: string) => void;
  onPlayerContextMenu?: (nickname: string, event: React.MouseEvent) => void;
}

/**
 * One name in a lineup, with the same hover card the channel roster shows.
 *
 * Its own component because the card is a hook, and a hook cannot be called
 * from inside the `map` over a team. Worth the component: this used to be a
 * native `title`, which is the one surface the theme cannot reach, so the
 * rating summary was a white operating-system slab in Aeolus' roster and a
 * white operating-system slab here, and only the roster got fixed.
 *
 * The card is `pointer-events: none`, so opening one over the panel this name
 * sits in cannot take the pointer away from it.
 */
function GameSummaryPlayerName({
  player,
  onOpenConversation,
  onPlayerContextMenu,
}: {
  player: GameSummaryPlayer;
  onOpenConversation?: (nickname: string) => void;
  onPlayerContextMenu?: (nickname: string, event: React.MouseEvent) => void;
}) {
  const { cardProps, anchorRef, card } = usePlayerRatingCard(
    displayName(player.login, player.profile),
    player.profile,
  );
  if (!onPlayerContextMenu) {
    // Nowhere to put a menu, so the name is not a control. The hover card still
    // is not a control either, so it can be offered anyway.
    return (
      <>
        <span
          className="chat-game-player-static"
          ref={anchorRef}
          {...cardProps}
        >
          {player.login}
        </span>
        {card}
      </>
    );
  }
  return (
    <>
      <button
        ref={anchorRef as React.RefObject<HTMLButtonElement>}
        type="button"
        className="chat-game-player"
        onClick={() => void openPlayerCard(player.profile?.id ?? null, player.login)}
        onDoubleClick={() => onOpenConversation?.(player.login)}
        onContextMenu={(event) => onPlayerContextMenu(player.login, event)}
        {...cardProps}
      >
        {player.login}
      </button>
      {card}
    </>
  );
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
  const leaderboard = gameLeaderboard(presence.game.ratingType);
  const mapGen = useNamedMapGeneration(presence.game.map);
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
          <div className="chat-game-card-map-wrap">
            <MapThumbnail
              mapName={presence.game.map}
              vault={vault}
              className="chat-game-card-map"
              placeholderClassName="chat-game-card-map chat-game-map-placeholder"
              preferCanonicalPreview
            />
            {(mapGen.canGenerate || mapGen.isGenerating) && (
              <button
                type="button"
                className="chat-game-card-map-btn"
                disabled={mapGen.isGenerating}
                onClick={(event) => {
                  event.stopPropagation();
                  mapGen.generate();
                }}
                title={mapGen.generateLabel}
                aria-label={mapGen.generateLabel}
              >
                <Icon
                  name={mapGen.isGenerating ? "refresh" : "plus"}
                  size={12}
                  className={mapGen.isGenerating ? "spin" : undefined}
                />
              </button>
            )}
          </div>
        )}
        <div className="chat-game-popover-info">
          <strong>{presence.game.title || t("chat.game.untitled")}</strong>
          <span>{presentation.displayName}</span>
        </div>
        <span className={`chat-game-status is-${presence.status}`}>{status}</span>
      </header>
      <div className="chat-game-meta">
        <span>{presence.game.modName.toUpperCase()}</span>
        <span>{presence.game.players}/{presence.game.maxPlayers} players</span>
        {/* Named where it is not the global board, and so is every rating in
            the lineup below it. */}
        {presence.game.averageRating > 0 && (
          <span>
            {presence.game.averageRating} {leaderboard === GLOBAL_LEADERBOARD
              ? "average"
              : `${leaderboardLabel(leaderboard)} average`}
          </span>
        )}
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
                    {/* The avatar the replay tab's lineup shows. FAF avatars
                        are 40 by 20, which is a lot of a narrow column, so the
                        panel drops it again at its narrowest step: see
                        `rosterTier`. An empty slot rather than none, or a team
                        where one player has an avatar would have its names
                        indented differently from the rest. */}
                    <span className="chat-game-player-avatar" aria-hidden="true">
                      {player.profile?.avatarUrl ? (
                        <img
                          src={player.profile.avatarUrl}
                          alt=""
                          title={player.profile.avatarTooltip || undefined}
                          width={40}
                          height={20}
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                        />
                      ) : null}
                    </span>
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
                    <GameSummaryPlayerName
                      player={player}
                      onOpenConversation={onOpenConversation}
                      onPlayerContextMenu={onPlayerContextMenu}
                    />
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
