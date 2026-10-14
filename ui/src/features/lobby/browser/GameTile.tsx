// One game as a tile in the grid view.

import { memo, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../design-system/Icon";
import type { Game, VaultMap, VaultMod } from "../../../ipc/bindings";
import { GameMapImage } from "../GameMapImage";
import { mapPresentation } from "../../../shared/mapPresentation";
import { featuredModLabel } from "../../../shared/featuredMods";
import { t } from "../../../i18n";
import { PlayerName } from "../../../shared/components/nameColors";
import { formatAge, playingCount, showsUnrankedTag, simModsKeepGameRanked } from "../../../shared/gameRules";
import { RatingRangeTag } from "./RatingRangeTag";
import { splitGoAdapterTitle } from "../../../shared/goAdapterTitle";
import { hideGlobalLineup, useGameLineupPosition, useGameSocialPosition } from "./hoverPopovers";
import { GameLineup } from "./GameLineup";
import { GameSocialPopover, foesHere, friendsHere } from "./GameSocialPopover";

export const EMPTY_SET: ReadonlySet<string> = new Set();

/** Past this many slots the dots would not fit beside the rating; the count says it. */
const MAX_SLOT_DOTS = 16;

/**
 * One dot per slot, filled for each player in it. Smaller from nine slots on,
 * so a 16-player lobby still leaves room for the rating beside it, and on a
 * narrow tile in two rows (`--slot-columns` dots to a row, the first row the
 * first half of the lobby).
 */
function SlotDots({ taken, slots }: { taken: number; slots: number }) {
  if (slots < 1 || slots > MAX_SLOT_DOTS) return null;
  const dense = slots > 8;
  return (
    <span
      className={`game-tile-slots${dense ? " is-dense" : ""}`}
      style={dense ? ({ "--slot-columns": Math.ceil(slots / 2) } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {Array.from({ length: slots }, (_, index) => (
        <i key={index} className={index < taken ? "is-taken" : undefined} />
      ))}
    </span>
  );
}

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
  const { title: shownTitle, goAdapter, expJavaAdapter } = splitGoAdapterTitle(game.title);
  const age = formatAge(game.hostedAt, now);
  // Co-op is its tab's own mode as FAF is the Custom tab's.
  const otherMod = game.modName && !["faf", "coop"].includes(game.modName.toLowerCase()) ? game.modName : null;

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
        {/* The picture carries nothing but the lock. The map's name sat on it
            in a plate of its own, which covered the terrain and looked stuck
            on; it is in the line under the title now. */}
        {game.passwordProtected && (
          <span className="game-tile-private" role="img" aria-label={t("lobby.browser.privateGame")} title={t("lobby.browser.privateGame")}>
            <Icon name="lock" size={14} />
          </span>
        )}
      </button>

      <button
        className="game-tile-body"
        onClick={onSelect}
        onDoubleClick={onJoin}
        aria-label={t("lobby.browser.tileAria", { title: shownTitle, host: game.host })}
        aria-pressed={selected}
        aria-describedby={tooltipPosition ? tooltipId : undefined}
      >
        {/* Facts without a caption over each. "PLAYER", "Ø RATING", "VERSION",
            "AGE" and "HOST:" on every tile made it read as a form; the values
            say what they are, and the words are on hover. */}
        {/* The title has its line to itself: the age beside it took about
            55 px of a line that is the first thing to run out of room. */}
        <span className="game-tile-title" title={shownTitle}>{shownTitle}</span>
        <span className="game-tile-where">
          <span className="game-tile-where-map" title={presentation.displayName}>{presentation.displayName}</span>
          <span className="game-tile-where-separator" aria-hidden="true">·</span>
          <span className="game-tile-where-host" title={`${t("lobby.browser.hostedBy")} ${game.host}`}>
            <PlayerName name={game.host} />
          </span>
        </span>
        <span className="game-tile-flags">
          {/* A tag among the tags, and the first of them. It is a condition of
              the lobby as "unranked" is: as bare numbers after the rating it
              did not read as a range at all. First, because this line clips
              what does not fit, and the range is the tag that decides whether
              the reader can join. */}
          {(game.ratingMin !== null || game.ratingMax !== null) && (
            <RatingRangeTag min={game.ratingMin} max={game.ratingMax} enforced={game.enforceRatingRange} />
          )}
          {/* Among the tags, and straight after the range: who is in the lobby
              is what a narrow tile can least afford to clip, and the tags
              about the game itself follow. A count is a property of the lobby
              the way "unranked" and "3 SIM" are, so it belongs with them and
              not off in the footer beside the host's name. Who they are is
              the popover's job, which the tag carries exactly as the list
              row's does. */}
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
          {/* Whether the game counts, before what it is played with: on a
              narrow tile the tags at the end are the ones left out. */}
          {unranked && <i className="unranked">{t("lobby.browser.unranked")}</i>}
          {/* Only a mode other than the tab's own: "FAF" on nearly every tile
              said nothing, and a rare one stands out because it is rare. As
              in the list row, and spelled the way the Host Game dialog spells
              it rather than as the `fafbeta` the server sends. */}
          {otherMod && <i title={featuredModLabel(otherMod)}>{featuredModLabel(otherMod)}</i>}
          {goAdapter && <i className="go-adapter" title={t("lobby.browser.goAdapterTitle")}>{t("lobby.browser.goAdapter")}</i>}
          {expJavaAdapter && <i className="go-adapter" title={t("lobby.browser.expJavaAdapterTitle")}>{t("lobby.browser.expJavaAdapter")}</i>}
          {simModCount > 0 && (
            <i
              className={simModsRanked ? "modded is-ranked" : "modded"}
              title={t(simModsRanked ? "lobby.browser.simModsRanked" : "lobby.browser.simModsUnranked", { count: simModCount })}
            >
              {t("lobby.browser.simModBadge", { count: simModCount })}
            </i>
          )}
        </span>
        {/* Who can still get in, at the bottom: whether there is room reads
            from the dots before the numbers are read, and the rating beside
            them says who is in. How long the lobby has been open closes the
            row, at its far end. */}
        <span className="game-tile-stats">
          <span className="game-tile-players" title={t("lobby.browser.tilePlayers", { players, max: game.maxPlayers })}>
            <SlotDots taken={players} slots={game.maxPlayers} />
            <b>{players}/{game.maxPlayers}</b>
          </span>
          <b title={t("lobby.browser.tileRatingTitle")}>
            {game.averageRating ? t("lobby.browser.tileRating", { rating: game.averageRating }) : t("common.notAvailable")}
          </b>
          <span className="game-tile-age" title={game.hostedAt ? t("lobby.browser.tileAge", { age }) : undefined}>{age}</span>
        </span>
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
