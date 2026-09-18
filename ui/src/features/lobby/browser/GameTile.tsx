// One game as a tile in the grid view.

import { memo } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../design-system/Icon";
import type { Game, VaultMap, VaultMod } from "../../../ipc/bindings";
import { GameMapImage } from "../GameMapImage";
import { mapPresentation } from "../../../shared/mapPresentation";
import { featuredModLabel } from "../../../shared/featuredMods";
import { t } from "../../../i18n";
import { PlayerName } from "../../../shared/components/nameColors";
import { formatAge, playingCount, showsUnrankedTag, simModsKeepGameRanked } from "./gameRules";
import { RatingRangeTag } from "./RatingRangeTag";
import { hideGlobalLineup, useGameLineupPosition, useGameSocialPosition } from "./hoverPopovers";
import { GameLineup } from "./GameLineup";
import { GameSocialPopover, foesHere, friendsHere } from "./GameSocialPopover";

export const EMPTY_SET: ReadonlySet<string> = new Set();

export const GameTile = memo(function GameTile({
  game,
  vault,
  vaultMods,
  friendSet,
  foeSet = EMPTY_SET,
  selected,
  now,
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
  selected: boolean;
  now: number;
  onSelect: () => void;
  onJoin: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const presentation = mapPresentation(vault, game.map);
  const simModCount = Object.keys(game.simMods).length;
  const simModsRanked = simModCount > 0 && simModsKeepGameRanked(game, vaultMods);
  const unranked = showsUnrankedTag(game, vault, vaultMods);
  const players = playingCount(game);
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
    <article
      className={
        `game-tile surface-panel${friends.length > 0 ? " has-friend" : ""}${foes.length > 0 ? " has-foe" : ""}${selected ? " active" : ""}`
      }
      onContextMenu={(event) => {
        hideGlobalLineup();
        onContextMenu?.(event);
      }}
      onMouseEnter={(event) => showLineup(event.currentTarget)}
      onMouseLeave={hideLineup}
      onFocus={(event) => showLineup(event.currentTarget, true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hideLineup();
      }}
    >
      {/* The picture is part of the tile, not a way out of it. It used to
          open the zoom dialog over the whole window, which is a lot to
          happen to somebody who clicked the half of a tile the eye lands on
          first; the same click on the other half only selected the game.
          Both halves do the same thing now, and the big preview is still one
          click away in the side panel, where it is asked for rather than
          arrived at. */}
      <button
        className="game-tile-map"
        onClick={onSelect}
        onDoubleClick={onJoin}
        aria-label={t("lobby.browser.tileMapAria", { map: presentation.displayName })}
        aria-pressed={selected}
        aria-describedby={tooltipPosition ? tooltipId : undefined}
      >
        <GameMapImage
          mapName={game.map}
          vault={vault}
          className="game-tile-map-image"
          placeholderClassName="game-tile-map-placeholder"
        />
        <span className="game-tile-map-name">{presentation.displayName}</span>
        {game.passwordProtected && (
          <span className="game-tile-private" role="img" aria-label={t("lobby.browser.privateGame")} title={t("lobby.browser.privateGame")}>
            <Icon name="lock" size={12} />
          </span>
        )}
      </button>

      <button
        className="game-tile-body"
        onClick={onSelect}
        onDoubleClick={onJoin}
        aria-label={t("lobby.browser.tileAria", { title: game.title, host: game.host })}
        aria-pressed={selected}
        aria-describedby={tooltipPosition ? tooltipId : undefined}
      >
        <span className="game-tile-title" title={game.title}>{game.title}</span>
        {/* Four facts, not a tag and three facts. The featured mod was a tag
            among "unranked" and "3 SIM", which read as something the lobby had
            switched on; it is a property of the game in the way its size and
            its rating are, so it stands in the row that carries those. Spelled
            the way the Host Game dialog spells it, from the same catalogue
            entries, rather than as the `fafdevelop` the server sends. */}
        <span className="game-tile-primary-stats">
          <span>
            <b>{players} / {game.maxPlayers}</b>
            <small>{t("lobby.browser.playersWord", { count: players })}</small>
          </span>
          <span><b>{game.averageRating || "N/A"}</b><small>{t("lobby.browser.column.rating")}</small></span>
          <span>
            <b title={featuredModLabel(game.modName)}>{featuredModLabel(game.modName)}</b>
            <small>{t("lobby.browser.column.version")}</small>
          </span>
          <span><b>{formatAge(game.hostedAt, now)}</b><small>{t("lobby.browser.column.age")}</small></span>
        </span>
        <span className="game-tile-flags">
          {simModCount > 0 && (
            <i
              className={simModsRanked ? "modded is-ranked" : "modded"}
              title={t(simModsRanked ? "lobby.browser.simModsRanked" : "lobby.browser.simModsUnranked", { count: simModCount })}
            >
              {simModCount} SIM
            </i>
          )}
          {unranked && <i className="unranked">{t("lobby.browser.unranked")}</i>}
          {/* Among the tags, where it was: a count is a property of the lobby
              the way "unranked" and "3 SIM" are, and the tile is scanned as a
              block rather than read left to right, so the friend count belongs
              with the other things that describe the game and not off in the
              footer beside the host's name. Who they are is the popover's job,
              which the tag carries exactly as the list row's does. */}
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
        <span className="game-tile-host"><small>{t("lobby.browser.host")}</small><b><PlayerName name={game.host} /></b></span>
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
    </article>
  );
});
