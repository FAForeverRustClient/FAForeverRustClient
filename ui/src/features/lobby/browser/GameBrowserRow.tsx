// One game as a row in the list view.

import { memo } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../design-system/Icon";
import type { Game, VaultMap, VaultMod } from "../../../ipc/bindings";
import { GameMapImage } from "../GameMapImage";
import { mapPresentation, mapVersionOf } from "../../../shared/mapPresentation";
import { t } from "../../../i18n";
import { PlayerName } from "../../../shared/components/nameColors";
import { formatAge, playingCount, showsUnrankedTag, simModsKeepGameRanked } from "./gameRules";
import { RatingRangeTag } from "./RatingRangeTag";
import { hideGlobalLineup, useGameLineupPosition, useGameSocialPosition } from "./hoverPopovers";
import { GameLineup } from "./GameLineup";
import { GameSocialPopover, foesHere, friendsHere } from "./GameSocialPopover";
import { EMPTY_SET } from "./GameTile";

export const GameBrowserRow = memo(function GameBrowserRow({
  game,
  vault,
  vaultMods,
  friendSet,
  foeSet = EMPTY_SET,
  now,
  columnStyle,
  selected,
  onSelect,
  onJoin,
  onContextMenu,
}: {
  game: Game;
  vault: VaultMap[];
  /** Read once by the browser rather than subscribed to by every row. */
  vaultMods: VaultMod[];
  /** The friend list, lower-cased once for the whole list. */
  friendSet: ReadonlySet<string>;
  /** The foe list, lower-cased once for the whole list. */
  foeSet?: ReadonlySet<string>;
  now?: number;
  /** The column template, built once by the browser and shared by every row. */
  columnStyle?: React.CSSProperties;
  selected: boolean;
  onSelect: () => void;
  onJoin: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const presentation = mapPresentation(vault, game.map);
  const unranked = showsUnrankedTag(game, vault, vaultMods);
  const simModCount = Object.keys(game.simMods).length;
  const simModsRanked = simModCount > 0 && simModsKeepGameRanked(game, vaultMods);
  const players = playingCount(game);
  const currentNow = now ?? Date.now();
  const { friends, label: friendLabel } = friendsHere(game, friendSet);
  const { foes, label: foeLabel } = foesHere(game, foeSet);
  const { tooltipId, tooltipPosition, showLineup, hideLineup } = useGameLineupPosition(game.id);
  const {
    socialPopoverId,
    socialCategory,
    socialPosition,
    showSocial,
    hideSocial,
  } = useGameSocialPosition(game.id);
  return (
    <>
      <button
        type="button"
        className={
          `game-browser-row${friends.length > 0 ? " has-friend" : ""}${foes.length > 0 ? " has-foe" : ""}${selected ? " active" : ""}`
        }
        style={columnStyle}
        onClick={onSelect}
        onDoubleClick={onJoin}
        onContextMenu={(event) => {
          hideGlobalLineup();
          onContextMenu?.(event);
        }}
        onMouseEnter={(event) => showLineup(event.currentTarget)}
        onMouseLeave={hideLineup}
        onFocus={(event) => showLineup(event.currentTarget, true)}
        onBlur={hideLineup}
        aria-describedby={tooltipPosition ? tooltipId : undefined}
      >
        <div className="game-browser-main">
          <div className="game-browser-thumb-wrapper">
            <GameMapImage
              mapName={game.map}
              vault={vault}
              className="game-browser-map-thumb"
              placeholderClassName="game-browser-map-placeholder"
            />
            {game.passwordProtected && (
              <span
                className="game-browser-thumb-lock"
                role="img"
                aria-label={t("lobby.browser.privateGame")}
                title={t("lobby.browser.privateGame")}
              >
                <Icon name="lock" size={11} />
              </span>
            )}
          </div>
          <div className="game-browser-meta">
            <span className="game-browser-title" title={game.title}>
              {game.title}
            </span>
            <div className="game-browser-details">
              <span className="game-browser-host" title={`${t("lobby.browser.host")} ${game.host}`}>
                {t("lobby.browser.host")}{" "}
                <strong>
                  <PlayerName name={game.host} />
                </strong>
              </span>
              <span className="game-browser-tags">
                <i>{game.modName || "faf"}</i>
                {simModCount > 0 && (
                  <i
                    className={simModsRanked ? "modded is-ranked" : "modded"}
                    title={t(simModsRanked ? "lobby.browser.simModsRanked" : "lobby.browser.simModsUnranked", { count: simModCount })}
                  >
                    {simModCount} SIM
                  </i>
                )}
                {unranked && <i className="unranked">{t("lobby.browser.unranked")}</i>}
                {friends.length > 0 && (
                  <i
                    className="friend"
                    onMouseEnter={(e) => {
                      e.stopPropagation();
                      showSocial(e.currentTarget, "friends");
                    }}
                    onMouseLeave={hideSocial}
                    onFocus={(e) => {
                      e.stopPropagation();
                      showSocial(e.currentTarget, "friends");
                    }}
                    onBlur={hideSocial}
                    tabIndex={0}
                    role="button"
                    aria-label={t("lobby.browser.friendCount", { count: friends.length })}
                    aria-describedby={socialPosition && socialCategory === "friends" ? socialPopoverId : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    {friendLabel}
                  </i>
                )}
                {foes.length > 0 && (
                  <i
                    className="foe"
                    onMouseEnter={(e) => {
                      e.stopPropagation();
                      showSocial(e.currentTarget, "foes");
                    }}
                    onMouseLeave={hideSocial}
                    onFocus={(e) => {
                      e.stopPropagation();
                      showSocial(e.currentTarget, "foes");
                    }}
                    onBlur={hideSocial}
                    tabIndex={0}
                    role="button"
                    aria-label={t("lobby.browser.foeCount", { count: foes.length })}
                    aria-describedby={socialPosition && socialCategory === "foes" ? socialPopoverId : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                  >
                    {foeLabel}
                  </i>
                )}
                {(game.ratingMin !== null || game.ratingMax !== null) && (
                  <RatingRangeTag min={game.ratingMin} max={game.ratingMax} enforced={game.enforceRatingRange} />
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="game-browser-map-col">
          <strong title={presentation.displayName}>{presentation.displayName}</strong>
          {/* Which version, not just which map. Two lobbies on "Dual Gap" can
              be on maps that play differently, and the folder name is the only
              place that ever said so. */}
          {mapVersionOf(game.map) && (
            <small className="game-browser-map-version">v{mapVersionOf(game.map)}</small>
          )}
        </div>

        <div className="game-browser-players-col">
          <span>{players} / {game.maxPlayers}</span>
        </div>

        <div className="game-browser-rating-col">
          <span>{game.averageRating || "N/A"}</span>
        </div>

        <div className="game-browser-age-col">
          <span>{formatAge(game.hostedAt, currentNow)}</span>
        </div>
      </button>
      {tooltipPosition && !socialPosition && createPortal(
        <GameLineup game={game} id={tooltipId} position={tooltipPosition} />,
        document.body,
      )}
      {socialPosition && socialCategory && createPortal(
        <GameSocialPopover
          game={game}
          players={socialCategory === "friends" ? friends : foes}
          category={socialCategory}
          id={socialPopoverId}
          position={socialPosition}
        />,
        document.body,
      )}
    </>
  );
});
