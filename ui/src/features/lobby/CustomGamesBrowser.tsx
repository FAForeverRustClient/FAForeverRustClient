import { memo, useEffect, useId, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { EmptyState } from "../../design-system/EmptyState";
import { Modal } from "../../design-system/Modal";
import type { Game, PlayerProfile, VaultMap, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { GameMapImage } from "./GameMapImage";
import { findVaultMap, isGeneratedMap, mapPresentation } from "../../shared/mapPresentation";
import { formatRelativeDuration } from "../../shared/durations";
import { flagSrc } from "../../shared/countryFlags";
import { findPlayer } from "../../store/reducer";
import { useAppStore } from "../../store/store";
import { sizeLabel } from "../maps/MapVaultComponents";
import { openPlayerCard } from "../player-card/playerCardActions";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";

export type GameViewMode = "list" | "tiles";

export function isCustomGameRanked(
  game: Game,
  vaultMaps: VaultMap[],
  vaultMods: VaultMod[],
): boolean {
  if (game.modName.toLocaleLowerCase() === "coop" || game.gameType.toLocaleLowerCase() === "coop") {
    return false;
  }

  // 1. Check map ranked status
  const mapName = game.map.trim().toLocaleLowerCase();
  const mapMeta = vaultMaps.find(
    (m) => m.folderName.toLocaleLowerCase() === mapName || mapName.startsWith(`${m.folderName.toLocaleLowerCase()}.`),
  );
  if (mapMeta && !mapMeta.ranked) {
    return false;
  }

  // 2. Check active SIM mods
  const simModUids = Object.keys(game.simMods);
  if (simModUids.length > 0) {
    const modsByUid = new Map(vaultMods.map((m) => [m.uid.toLocaleLowerCase(), m]));
    for (const uid of simModUids) {
      const mod = modsByUid.get(uid.toLocaleLowerCase());
      // Any unranked SIM mod or unknown SIM mod makes the match unranked
      if (!mod || !mod.ranked) {
        return false;
      }
    }
  }

  return true;
}

interface Props {
  games: Game[];
  totalGames: number;
  selectedId: number | null;
  vault: VaultMap[];
  viewMode: GameViewMode;
  onSelect: (id: number) => void;
  onJoin: (game: Game) => void;
  onPreview?: (game: Game) => void;
}

type ContextMenu = { game: Game; x: number; y: number };
type TooltipPosition = { left: number; top?: number; bottom?: number };

function observerTeam(team: string): boolean {
  return team === "-1" || team === "null";
}

function playingCount(game: Game): number {
  const count = Object.entries(game.teams)
    .filter(([team]) => !observerTeam(team))
    .reduce((total, [, players]) => total + players.length, 0);
  return count || game.players;
}

function formatAge(hostedAt: string | null, now: number): string {
  if (!hostedAt) return t("lobby.browser.new");
  const hosted = Date.parse(hostedAt);
  if (!Number.isFinite(hosted)) return t("lobby.browser.new");
  return formatRelativeDuration((now - hosted) / 1000);
}

type ActiveLineup = {
  gameId: number;
  position: TooltipPosition;
} | null;

let activeLineup: ActiveLineup = null;
const lineupListeners = new Set<() => void>();

function subscribeLineup(listener: () => void) {
  lineupListeners.add(listener);
  return () => {
    lineupListeners.delete(listener);
  };
}

export function getActiveLineupSnapshot() {
  return activeLineup;
}

export function hideGlobalLineup() {
  if (activeLineup !== null) {
    activeLineup = null;
    for (const listener of lineupListeners) {
      listener();
    }
  }
}

export function setGlobalLineup(gameId: number, position: TooltipPosition) {
  activeLineup = { gameId, position };
  for (const listener of lineupListeners) {
    listener();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("blur", hideGlobalLineup);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideGlobalLineup();
  });
  window.addEventListener("scroll", hideGlobalLineup, true);
  window.addEventListener("resize", hideGlobalLineup);
  document.addEventListener("mouseleave", hideGlobalLineup);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideGlobalLineup();
  });
}

function useGameLineupPosition(gameId: number) {
  const tooltipId = useId();
  const currentActive = useSyncExternalStore(subscribeLineup, getActiveLineupSnapshot, () => null);
  const tooltipPosition = currentActive?.gameId === gameId ? currentActive.position : null;

  const showLineup = (target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const tooltipWidth = Math.min(430, viewportWidth - 32);
    const halfWidth = tooltipWidth / 2;
    const left = Math.min(
      viewportWidth - 16 - halfWidth,
      Math.max(16 + halfWidth, bounds.left + bounds.width / 2),
    );
    const hasRoomBelow = viewportHeight - bounds.bottom >= 260;
    const position = hasRoomBelow
      ? { left, top: bounds.bottom + 6 }
      : { left, bottom: viewportHeight - bounds.top + 6 };
    setGlobalLineup(gameId, position);
  };

  const hideLineup = () => {
    if (currentActive?.gameId === gameId) {
      hideGlobalLineup();
    }
  };

  useEffect(() => {
    return () => {
      if (activeLineup?.gameId === gameId) {
        hideGlobalLineup();
      }
    };
  }, [gameId]);

  return {
    tooltipId,
    tooltipPosition,
    showLineup,
    hideLineup,
  };
}

function GameLineup({
  game,
  id,
  position,
}: {
  game: Game;
  id: string;
  position: TooltipPosition;
}) {
  const social = useAppStore((state) => state.state.social);
  const teams = Object.entries(game.teams)
    .filter(([team, players]) => !observerTeam(team) && players.length > 0)
    .sort(([left], [right]) => Number(left) - Number(right));
  const observers = Object.entries(game.teams)
    .filter(([team]) => observerTeam(team))
    .flatMap(([, players]) => players);
  const mods = Object.values(game.simMods);
  const mirrored = teams.length === 2;

  const profileFor = (login: string) => findPlayer(social, login);
  return (
    <aside
      className="game-tile-tooltip"
      id={id}
      role="tooltip"
      style={position}
    >
      <header className="game-lineup-title">{game.title}</header>
      {mirrored && <TeamBalance teams={teams} profileFor={profileFor} />}
      {teams.length > 0 ? (
        <div
          className={
            mirrored
              ? "game-lineup-teams is-mirrored"
              : teams.length === 1
              ? "game-lineup-teams is-single"
              : "game-lineup-teams"
          }
        >
          {teams.map(([team, players], index) => (
            <GameLineupTeam
              key={team}
              team={team}
              players={players}
              soleTeam={teams.length === 1}
              side={mirrored ? (index === 0 ? "left" : "right") : "neutral"}
              profileFor={profileFor}
            />
          ))}
          {mirrored && <span className="game-lineup-versus" aria-hidden>VS</span>}
        </div>
      ) : (
        <span className="game-lineup-empty">{t("lobby.browser.noLineup")}</span>
      )}
      {observers.length > 0 && (
        <section className="game-lineup-observers">
          <b>{t("lobby.browser.observers")}</b>
          <span>{observers.join(", ")}</span>
        </section>
      )}
      {mods.length > 0 && (
        <section className="game-lineup-mods">
          <b>{t("lobby.browser.simMods")}</b>
          <span title={mods.join(", ")}>
            {mods.length <= 4
              ? mods.join(", ")
              : `${mods.slice(0, 4).join(", ")}, ${t("lobby.browser.moreMods", { count: mods.length - 4 })}`}
          </span>
        </section>
      )}
    </aside>
  );
}

type LineupSide = "left" | "right" | "neutral";

export function displayedRating(profile: PlayerProfile | undefined): number | null {
  return profile && profile.globalRating !== 0 ? profile.globalRating : null;
}

export function displayTeamName(team: string, soleTeam: boolean): string {
  if (team === "-1" || team === "null") return t("lobby.details.observers");
  const numeric = Number(team);
  if (!Number.isInteger(numeric)) return `Team ${team}`;
  // Team 1 is the server's "no team" bucket. When it holds everyone the game is
  // a free-for-all, which says more than "No team" did.
  if (numeric === 1) return soleTeam ? t("lobby.browser.freeForAll") : t("lobby.browser.unassigned");
  return `Team ${numeric - 1}`;
}

/** Combined displayed rating of a team, or `null` if any member is unknown. */
function teamRating(
  players: string[],
  profileFor: (login: string) => PlayerProfile | undefined,
): number | null {
  const ratings = players.map((login) => displayedRating(profileFor(login)));
  return ratings.every((rating): rating is number => rating !== null)
    ? ratings.reduce((sum, rating) => sum + rating, 0)
    : null;
}

/**
 * How the two sides compare, as a proportional bar.
 *
 * The tooltip already listed both totals, but at opposite outer edges of the
 * panel with nothing saying what they were. "Is this game balanced" is the
 * question a lobby browser is actually being asked, so it gets answered
 * directly instead of left as arithmetic between two grey numbers.
 */
function TeamBalance({
  teams,
  profileFor,
}: {
  teams: [string, string[]][];
  profileFor: (login: string) => PlayerProfile | undefined;
}) {
  const left = teamRating(teams[0][1], profileFor);
  const right = teamRating(teams[1][1], profileFor);
  if (left === null || right === null || left + right === 0) return null;

  const leftShare = Math.round((left / (left + right)) * 100);
  const rightShare = 100 - leftShare;

  return (
    <div className="game-lineup-balance">
      <span
        className="game-lineup-balance-bar"
        role="img"
        aria-label={t("lobby.browser.shareAria", { left: leftShare, right: rightShare })}
      >
        <span style={{ width: `${leftShare}%` }} />
      </span>
      <span className="game-lineup-balance-note">
        {leftShare}% / {rightShare}%
      </span>
    </div>
  );
}

function GameLineupTeam({
  team,
  players,
  soleTeam,
  side,
  profileFor,
}: {
  team: string;
  players: string[];
  soleTeam: boolean;
  side: LineupSide;
  profileFor: (login: string) => PlayerProfile | undefined;
}) {
  const profiles = players.map((login) => profileFor(login));
  const ratings = profiles.map(displayedRating);
  const total = teamRating(players, profileFor);

  return (
    <section className={`game-lineup-team is-${side}${soleTeam ? " is-sole" : ""}`}>
      <header>
        <b>{displayTeamName(team, soleTeam)}</b>
        {total === null ? (
          <span>{players.length} player{players.length === 1 ? "" : "s"}</span>
        ) : (
          <span title={t("lobby.browser.combinedRating")}>
            <strong>{total.toLocaleString("en-US")}</strong> rating
          </span>
        )}
      </header>
      <ul>
        {/* Both columns read flag, name, rating. They used to be mirrored, which
            put the two sets of ratings against the panel's outer edges: the
            furthest apart the layout allowed, for the numbers most likely to be
            compared. */}
        {players.map((login, index) => {
          const profile = profiles[index];
          const rating = ratings[index];
          return (
            <li key={login}>
              {profile?.country ? (
                <img
                  src={flagSrc(profile.country)}
                  alt={profile.country.toUpperCase()}
                  width={16}
                  height={16}
                  decoding="async"
                  draggable={false}
                />
              ) : <i className="game-lineup-flag-placeholder" />}
              <button
                type="button"
                className="game-team-player"
                onClick={() => openPlayerCard(profile?.id ?? null, login)}
                title={`Open ${login}'s profile`}
              >
                <PlayerName name={login} className="game-lineup-player" />
              </button>
              <span className="game-lineup-rating">{rating === null ? "N/A" : rating}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export const GameTile = memo(function GameTile({
  game,
  vault,
  selected,
  now,
  onSelect,
  onJoin,
  onPreview,
  onContextMenu,
}: {
  game: Game;
  vault: VaultMap[];
  selected: boolean;
  now: number;
  onSelect: () => void;
  onJoin: () => void;
  onPreview?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const vaultMods = useAppStore((state) => state.state.mods.vault);
  const presentation = mapPresentation(vault, game.map);
  const simModCount = Object.keys(game.simMods).length;
  const isRanked = isCustomGameRanked(game, vault, vaultMods);
  const players = playingCount(game);
  const { tooltipId, tooltipPosition, showLineup, hideLineup } = useGameLineupPosition(game.id);

  return (
    <article
      className={selected ? "game-tile surface-panel active" : "game-tile surface-panel"}
      onContextMenu={(event) => {
        hideGlobalLineup();
        onContextMenu?.(event);
      }}
      onMouseEnter={(event) => showLineup(event.currentTarget)}
      onMouseLeave={hideLineup}
      onFocus={(event) => showLineup(event.currentTarget)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hideLineup();
      }}
    >
      <button
        className="game-tile-map"
        onClick={() => {
          onSelect();
          onPreview?.();
        }}
        aria-label={`Preview ${presentation.displayName}`}
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
        aria-label={`${game.title}, hosted by ${game.host}. Double-click to join.`}
        aria-pressed={selected}
        aria-describedby={tooltipPosition ? tooltipId : undefined}
      >
        <span className="game-tile-title" title={game.title}>{game.title}</span>
        <span className="game-tile-primary-stats">
          <span><b>{players} / {game.maxPlayers}</b><small>{players === 1 ? "player" : "players"}</small></span>
          <span><b>{formatAge(game.hostedAt, now)}</b><small>age</small></span>
          <span><b>{game.averageRating || "N/A"}</b><small>avg. rating</small></span>
        </span>
        <span className="game-tile-flags">
          <i>{game.modName || "faf"}</i>
          {simModCount > 0 && (
            <i className="modded" title={`${simModCount} SIM mod${simModCount === 1 ? "" : "s"}`}>
              {simModCount} SIM
            </i>
          )}
          {!isRanked && <i className="unranked">{t("lobby.browser.unranked")}</i>}
          {(game.ratingMin !== null || game.ratingMax !== null) && (
            <i title={`Rating range: ${game.ratingMin ?? t("lobby.browser.any")} - ${game.ratingMax ?? t("lobby.browser.any")}`}>
              {game.ratingMin ?? t("lobby.browser.any")}-{game.ratingMax ?? t("lobby.browser.any")}
            </i>
          )}
        </span>
        <span className="game-tile-host"><small>{t("lobby.browser.host")}</small><b><PlayerName name={game.host} /></b></span>
      </button>
      {tooltipPosition && createPortal(
        <GameLineup game={game} id={tooltipId} position={tooltipPosition} />,
        document.body,
      )}
    </article>
  );
});

export const GameBrowserRow = memo(function GameBrowserRow({
  game,
  vault,
  now,
  selected,
  onSelect,
  onJoin,
  onContextMenu,
}: {
  game: Game;
  vault: VaultMap[];
  now?: number;
  selected: boolean;
  onSelect: () => void;
  onJoin: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const vaultMods = useAppStore((state) => state.state.mods.vault);
  const presentation = mapPresentation(vault, game.map);
  const isRanked = isCustomGameRanked(game, vault, vaultMods);
  const simModCount = Object.keys(game.simMods).length;
  const players = playingCount(game);
  const currentNow = now ?? Date.now();
  const { tooltipId, tooltipPosition, showLineup, hideLineup } = useGameLineupPosition(game.id);
  return (
    <>
      <button
        type="button"
        className={selected ? "game-browser-row active" : "game-browser-row"}
        onClick={onSelect}
        onDoubleClick={onJoin}
        onContextMenu={(event) => {
          hideGlobalLineup();
          onContextMenu?.(event);
        }}
        onMouseEnter={(event) => showLineup(event.currentTarget)}
        onMouseLeave={hideLineup}
        onFocus={(event) => showLineup(event.currentTarget)}
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
              <span className="game-browser-host">
                {t("lobby.browser.host")}{" "}
                <strong>
                  <PlayerName name={game.host} />
                </strong>
              </span>
              <span className="game-browser-tags">
                <i>{game.modName || "faf"}</i>
                {simModCount > 0 && (
                  <i className="modded" title={`${simModCount} SIM mod${simModCount === 1 ? "" : "s"}`}>
                    {simModCount} SIM
                  </i>
                )}
                {!isRanked && <i className="unranked">{t("lobby.browser.unranked")}</i>}
                {(game.ratingMin !== null || game.ratingMax !== null) && (
                  <i title={`Rating range: ${game.ratingMin ?? t("lobby.browser.any")} - ${game.ratingMax ?? t("lobby.browser.any")}`}>
                    {game.ratingMin ?? t("lobby.browser.any")}-{game.ratingMax ?? t("lobby.browser.any")}
                  </i>
                )}
              </span>
            </div>
          </div>
        </div>

        <div className="game-browser-map-col">
          <strong title={presentation.displayName}>{presentation.displayName}</strong>
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
      {tooltipPosition && createPortal(
        <GameLineup game={game} id={tooltipId} position={tooltipPosition} />,
        document.body,
      )}
    </>
  );
});

export const GamePreviewDialog = memo(function GamePreviewDialog({
  game,
  vault,
  onClose,
  onJoin,
}: {
  game: Game;
  vault: VaultMap[];
  onClose: () => void;
  onJoin: () => void;
}) {
  const presentation = mapPresentation(vault, game.map);
  const vaultMap = findVaultMap(vault, game.map);
  const maps = useAppStore((state) => state.state.maps);
  const mods = useAppStore((state) => state.state.mods);
  const lobby = useAppStore((state) => state.state.lobby);
  const social = useAppStore((state) => state.state.social);
  const player = useAppStore((state) => state.state.auth.player);
  const isRanked = isCustomGameRanked(game, vault, mods.vault);
  const mapGenStatus = useAppStore((state) => state.state.mapGenerator.status);
  const isGenerated = isGeneratedMap(game.map);
  const installed = maps.installed.some(
    (map) =>
      map.folderName.toLowerCase() === game.map.toLowerCase() ||
      map.folderName.toLowerCase().startsWith(`${game.map.toLowerCase()}.`),
  );
  const isGeneratingThisMap =
    mapGenStatus.type === "generating" ||
    mapGenStatus.type === "downloading" ||
    mapGenStatus.type === "resolvingVersion";
  const players = playingCount(game);
  const simMods = Object.values(game.simMods);
  const teams = Object.entries(game.teams).filter(([, p]) => p.length > 0);
  const ratingRange = game.ratingMin !== null || game.ratingMax !== null
    ? t("lobby.browser.ratingBetween", { min: game.ratingMin ?? t("lobby.browser.any"), max: game.ratingMax ?? t("lobby.browser.any") })
    : t("lobby.browser.openRange");

  const [expandedMods, setExpandedMods] = useState(false);
  const isHost = !!player && game.host.localeCompare(player.name, undefined, { sensitivity: "base" }) === 0;
  const isPlayerInGame = !!player && Object.values(game.teams).some((teamPlayers) =>
    teamPlayers.some((p) => p.localeCompare(player.name, undefined, { sensitivity: "base" }) === 0)
  );

  const isJoiningThis = lobby.join.type === "joining" && lobby.join.payload.id === game.id;
  const isPreparingThis = lobby.join.type === "preparing";
  const isLaunchedThis = lobby.join.type === "launched" && lobby.join.payload.launch.uid === game.id;
  const isInGame = lobby.join.type === "inGame";

  const isBusyWithOther = (lobby.join.type === "joining" && lobby.join.payload.id !== game.id)
    || (lobby.join.type === "launched" && !isLaunchedThis)
    || (isInGame && !isPlayerInGame && !isHost);

  let joinLabel = t("lobby.details.joinGame");
  let joinDisabled = false;
  let joinTitle: string | undefined;

  if (isHost) {
    joinLabel = t("lobby.details.hostedByYou");
    joinDisabled = true;
  } else if (isPlayerInGame) {
    joinLabel = t("lobby.details.inGame");
    joinDisabled = true;
  } else if (isJoiningThis) {
    joinLabel = t("lobby.details.joining");
    joinDisabled = true;
  } else if (isPreparingThis) {
    joinLabel = t("lobby.details.preparing");
    joinDisabled = true;
  } else if (isBusyWithOther) {
    joinLabel = t("lobby.details.joinGame");
    joinDisabled = true;
    joinTitle = t("lobby.details.alreadyInGame");
  }

  return (
    <div className="game-preview-dialog">
      <header className="game-preview-dialog-header">
        <div>
          <span className="game-preview-dialog-kicker">{t("lobby.browser.mapPreview")}</span>
          <h2>{presentation.displayName}</h2>
          <p>{game.title}</p>
        </div>
      </header>
      <div className="game-preview-dialog-body">
        <div className="game-preview-dialog-map">
          <GameMapImage
            mapName={game.map}
            vault={vault}
            className="game-preview-dialog-image"
            placeholderClassName="game-preview-dialog-placeholder"
            large
          />
          {game.passwordProtected && (
            <span className="game-preview-dialog-private" role="img" aria-label={t("lobby.browser.privateGame")} title={t("lobby.browser.privateGame")}>
              <Icon name="lock" size={13} />
              {t("lobby.browser.private")}
            </span>
          )}
        </div>
        <section className="game-preview-dialog-info" aria-label={t("lobby.browser.gameDetails")}>
          <div className="game-preview-dialog-host">
            <span>{t("lobby.browser.hostedBy")}</span>
            <button
              type="button"
              className="game-team-player"
              onClick={() => openPlayerCard(findPlayer(social, game.host)?.id ?? null, game.host)}
              title={`Open ${game.host}'s profile`}
            >
              <strong><PlayerName name={game.host} /></strong>
            </button>
          </div>
          <dl className="game-preview-dialog-summary">
            <div><dt>{t("lobby.host.featuredMod")}</dt><dd>{game.modName || "faf"}</dd></div>
            <div><dt>{t("lobby.browser.players")}</dt><dd>{players} / {game.maxPlayers}</dd></div>
            <div><dt>{t("lobby.browser.averageRating")}</dt><dd>{game.averageRating || t("lobby.browser.unrated")}</dd></div>
            <div><dt>{t("lobby.browser.ratingRange")}</dt><dd>{ratingRange}</dd></div>
            <div>
              <dt>{t("lobby.browser.ranking")}</dt>
              <dd>
                <span className={isRanked ? "map-vault-type ranked" : "map-vault-type unranked"}>
                  {t(isRanked ? "lobby.browser.ranked" : "lobby.browser.unranked")}
                </span>
              </dd>
            </div>
            {vaultMap && <div><dt>{t("lobby.browser.mapSize")}</dt><dd>{sizeLabel(vaultMap)}</dd></div>}
          </dl>
          {simMods.length > 0 && (
            <div className="game-preview-dialog-section">
              <span>{t("lobby.browser.simMods")}</span>
              <div className="game-detail-tags">
                {(expandedMods ? simMods : simMods.slice(0, 4)).map((mod) => (
                  <span className="tag" key={mod}>{mod}</span>
                ))}
                {simMods.length > 4 && (
                  <button
                    type="button"
                    className="game-detail-more-tags"
                    onClick={() => setExpandedMods((prev) => !prev)}
                  >
                    {expandedMods
                      ? t("lobby.details.showLessMods")
                      : t("lobby.details.showMoreMods", { count: simMods.length - 4 })}
                  </button>
                )}
              </div>
            </div>
          )}
          {teams.length > 0 && (
            <div className="game-preview-dialog-section">
              <span>{t("lobby.details.teams")}</span>
              <div className="game-preview-dialog-teams">
                {teams.map(([team, teamPlayers]) => (
                  <div className="game-team" key={team}>
                    <div className="game-team-header">
                      <span>{displayTeamName(team, teams.length === 1)}</span>
                    </div>
                    <ul className="game-team-player-list">
                      {teamPlayers.map((login) => {
                        const profile = findPlayer(social, login);
                        const rating = displayedRating(profile);
                        return (
                          <li key={login} className="game-preview-player-row">
                            {profile?.country ? (
                              <img
                                src={flagSrc(profile.country)}
                                alt={profile.country.toUpperCase()}
                                width={16}
                                height={16}
                                decoding="async"
                                draggable={false}
                              />
                            ) : (
                              <i className="game-lineup-flag-placeholder" />
                            )}
                            <button
                              type="button"
                              className="game-team-player"
                              onClick={() => openPlayerCard(profile?.id ?? null, login)}
                              title={`Open ${login}'s profile`}
                            >
                              <PlayerName name={login} />
                            </button>
                            {rating !== null && <span className="player-rating">{rating}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
      <footer className="game-preview-dialog-actions play-dialog-actions">
        {!installed && isGenerated && (
          <Button
            disabled={isGeneratingThisMap}
            onClick={() =>
              ipc.send({
                kind: "MapGenerator",
                command: {
                  type: "generateNamed",
                  payload: {
                    mapName: game.map,
                  },
                },
              })
            }
          >
            <Icon name="plus" size={13} />
            {isGeneratingThisMap ? t("lobby.browser.generatingMap") : t("lobby.browser.generateMap")}
          </Button>
        )}
        {!installed && !isGenerated && vaultMap && (
          <Button
            onClick={() =>
              ipc.send({
                kind: "Maps",
                command: {
                  type: "installMap",
                  payload: {
                    folderName: vaultMap.folderName,
                    downloadUrl: vaultMap.downloadUrl,
                  },
                },
              })
            }
          >
            {t("lobby.browser.downloadMap")}
          </Button>
        )}
        <Button onClick={onClose}>{t("lobby.browser.close")}</Button>
        <Button variant="primary" disabled={joinDisabled} title={joinTitle} onClick={onJoin}>{joinLabel}</Button>
      </footer>
    </div>
  );
});

export function CustomGamesBrowser({
  games,
  totalGames,
  selectedId,
  vault,
  viewMode,
  onSelect,
  onJoin,
  onPreview: onPreviewProp,
}: Props) {
  useLocale();
  const [now, setNow] = useState(() => Date.now());
  const [internalPreviewGame, setInternalPreviewGame] = useState<Game | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  const handlePreview = onPreviewProp ?? setInternalPreviewGame;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  const openContextMenu = (event: React.MouseEvent, game: Game) => {
    event.preventDefault();
    hideGlobalLineup();
    onSelect(game.id);
    setContextMenu({
      game,
      x: Math.min(event.clientX, window.innerWidth - 202),
      y: Math.min(event.clientY, window.innerHeight - 112),
    });
  };

  const tileColumns = useAppStore((state) => state.state.settings.appearance.gameTileColumns) ?? 0;
  const tileGridStyle = viewMode === "tiles" && tileColumns > 0
    ? { gridTemplateColumns: `repeat(${tileColumns}, minmax(0, 1fr))` }
    : undefined;

  return (
    <section className={`game-browser-panel surface-panel game-browser-${viewMode}`}>
      {viewMode === "list" && (
        <div className="game-browser-head">
          <span>{t("lobby.browser.column.game")}</span>
          <span>{t("lobby.browser.column.map")}</span>
          <span>{t("lobby.browser.column.players")}</span>
          <span>{t("lobby.browser.column.rating")}</span>
          <span>{t("lobby.browser.column.age")}</span>
        </div>
      )}
      <div
        className={viewMode === "tiles" ? "game-tile-grid" : "game-browser-list"}
        style={tileGridStyle}
      >
        {games.length === 0 ? (
          <EmptyState
            icon="search"
            title={t("lobby.browser.noMatch")}
            hint={t("lobby.browser.noMatchHint")}
          />
        ) : viewMode === "tiles" ? (
          games.map((game) => (
            <GameTile
              key={game.id}
              game={game}
              vault={vault}
              selected={selectedId === game.id}
              now={now}
              onSelect={() => onSelect(game.id)}
              onJoin={() => onJoin(game)}
              onPreview={() => handlePreview(game)}
              onContextMenu={(event) => openContextMenu(event, game)}
            />
          ))
        ) : (
          games.map((game) => (
            <GameBrowserRow
              key={game.id}
              game={game}
              vault={vault}
              now={now}
              selected={selectedId === game.id}
              onSelect={() => onSelect(game.id)}
              onJoin={() => onJoin(game)}
              onContextMenu={(event) => openContextMenu(event, game)}
            />
          ))
        )}
      </div>
      <footer className="game-browser-footer">
        <span>Showing {games.length} of {totalGames} games</span>
        <span>{t(viewMode === "tiles" ? "lobby.browser.tileHint" : "lobby.browser.listHint")}</span>
      </footer>

      {!onPreviewProp && internalPreviewGame && (
        <Modal onClose={() => setInternalPreviewGame(null)}>
          <GamePreviewDialog
            game={internalPreviewGame}
            vault={vault}
            onClose={() => setInternalPreviewGame(null)}
            onJoin={() => onJoin(internalPreviewGame)}
          />
        </Modal>
      )}

      {contextMenu && (
        <div
          className="game-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <strong>{contextMenu.game.title}</strong>
          <button onClick={() => { onJoin(contextMenu.game); setContextMenu(null); }}>{t("lobby.browser.joinGame")}</button>
          <button onClick={() => { handlePreview(contextMenu.game); setContextMenu(null); }}>{t("lobby.browser.previewMap")}</button>
        </div>
      )}
    </section>
  );
}
