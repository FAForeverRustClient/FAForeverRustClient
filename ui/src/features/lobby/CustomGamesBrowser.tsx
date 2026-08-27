import { memo, useEffect, useId, useState } from "react";
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

function useGameLineupPosition() {
  const tooltipId = useId();
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition | null>(null);

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
    setTooltipPosition(hasRoomBelow
      ? { left, top: bounds.bottom + 6 }
      : { left, bottom: viewportHeight - bounds.top + 6 });
  };

  return {
    tooltipId,
    tooltipPosition,
    showLineup,
    hideLineup: () => setTooltipPosition(null),
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
        <div className={mirrored ? "game-lineup-teams is-mirrored" : "game-lineup-teams"}>
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
          <span>{mods.join(", ")}</span>
        </section>
      )}
    </aside>
  );
}

type LineupSide = "left" | "right" | "neutral";

function displayedRating(profile: PlayerProfile | undefined): number | null {
  return profile && profile.globalRating !== 0 ? profile.globalRating : null;
}

function displayTeamName(team: string, soleTeam: boolean): string {
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
    <section className={`game-lineup-team is-${side}`}>
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
  const { tooltipId, tooltipPosition, showLineup, hideLineup } = useGameLineupPosition();

  return (
    <article
      className={selected ? "game-tile surface-panel active" : "game-tile surface-panel"}
      onContextMenu={onContextMenu}
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
          {simModCount > 0 && <i className="modded">{simModCount} SIM mod{simModCount === 1 ? "" : "s"}</i>}
          {!isRanked && <i className="unranked">{t("lobby.browser.unranked")}</i>}
          {(game.ratingMin !== null || game.ratingMax !== null) && (
            <i>{game.ratingMin ?? t("lobby.browser.any")}–{game.ratingMax ?? t("lobby.browser.any")}</i>
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
  selected,
  onSelect,
  onJoin,
  onContextMenu,
}: {
  game: Game;
  vault: VaultMap[];
  selected: boolean;
  onSelect: () => void;
  onJoin: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const vaultMods = useAppStore((state) => state.state.mods.vault);
  const presentation = mapPresentation(vault, game.map);
  const isRanked = isCustomGameRanked(game, vault, vaultMods);
  const { tooltipId, tooltipPosition, showLineup, hideLineup } = useGameLineupPosition();
  return (
    <>
      <button
        className={selected ? "game-browser-row active" : "game-browser-row"}
        onClick={onSelect}
        onDoubleClick={onJoin}
        onContextMenu={onContextMenu}
        onMouseEnter={(event) => showLineup(event.currentTarget)}
        onMouseLeave={hideLineup}
        onFocus={(event) => showLineup(event.currentTarget)}
        onBlur={hideLineup}
        aria-describedby={tooltipPosition ? tooltipId : undefined}
      >
        <span className="game-browser-name">
          {game.passwordProtected ? <Icon name="lock" size={13} /> : <i />}
          <GameMapImage
            mapName={game.map}
            vault={vault}
            className="game-browser-map-thumb"
            placeholderClassName="game-browser-map-placeholder"
          />
          <span>
            <strong>{game.title}</strong>
            <small>
              <PlayerName name={game.host} /> · {game.modName || "faf"}
              {!isRanked && ` · ${t("lobby.browser.unranked")}`}
            </small>
          </span>
        </span>
        <span>{presentation.displayName}</span>
        <span>{playingCount(game)}/{game.maxPlayers}</span>
        <span>{game.averageRating || "N/A"}</span>
      </button>
      {tooltipPosition && createPortal(
        <GameLineup game={game} id={tooltipId} position={tooltipPosition} />,
        document.body,
      )}
    </>
  );
});

function GamePreviewDialog({
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
  const vaultMods = useAppStore((state) => state.state.mods.vault);
  const isRanked = isCustomGameRanked(game, vault, vaultMods);
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
  const ratingRange = game.ratingMin !== null || game.ratingMax !== null
    ? t("lobby.browser.ratingBetween", { min: game.ratingMin ?? t("lobby.browser.any"), max: game.ratingMax ?? t("lobby.browser.any") })
    : t("lobby.browser.openRange");

  return (
    <div className="game-preview-dialog">
      <header className="game-preview-dialog-header">
        <div>
          <span className="game-preview-dialog-kicker">{t("lobby.browser.mapPreview")}</span>
          <h2>{presentation.displayName}</h2>
          <p>{game.title}</p>
        </div>
        <span className="game-preview-dialog-mod">{game.modName || "faf"}</span>
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
              onClick={() => openPlayerCard(findPlayer(useAppStore.getState().state.social, game.host)?.id ?? null, game.host)}
              title={`Open ${game.host}'s profile`}
            >
              <strong><PlayerName name={game.host} /></strong>
            </button>
          </div>
          <dl className="game-preview-dialog-summary">
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
              <div>{simMods.map((mod) => <span className="tag" key={mod}>{mod}</span>)}</div>
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
        <Button variant="primary" onClick={onJoin}>{t("lobby.browser.joinGame")}</Button>
      </footer>
    </div>
  );
};

export function CustomGamesBrowser({
  games,
  totalGames,
  selectedId,
  vault,
  viewMode,
  onSelect,
  onJoin,
}: Props) {
  useLocale();
  const [now, setNow] = useState(() => Date.now());
  const [previewGame, setPreviewGame] = useState<Game | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

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
    onSelect(game.id);
    setContextMenu({
      game,
      x: Math.min(event.clientX, window.innerWidth - 202),
      y: Math.min(event.clientY, window.innerHeight - 112),
    });
  };

  return (
    <section className={`game-browser-panel surface-panel game-browser-${viewMode}`}>
      {viewMode === "list" && (
        <div className="game-browser-head">
          <span>{t("lobby.browser.column.game")}</span><span>{t("lobby.browser.column.map")}</span><span>{t("lobby.browser.column.players")}</span><span>{t("lobby.browser.column.rating")}</span>
        </div>
      )}
      <div className={viewMode === "tiles" ? "game-tile-grid" : "game-browser-list"}>
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
              onPreview={() => setPreviewGame(game)}
              onContextMenu={(event) => openContextMenu(event, game)}
            />
          ))
        ) : (
          games.map((game) => (
            <GameBrowserRow
              key={game.id}
              game={game}
              vault={vault}
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

      {previewGame && (
        <Modal onClose={() => setPreviewGame(null)}>
          <GamePreviewDialog
            game={previewGame}
            vault={vault}
            onClose={() => setPreviewGame(null)}
            onJoin={() => onJoin(previewGame)}
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
          <button onClick={() => { setPreviewGame(contextMenu.game); setContextMenu(null); }}>{t("lobby.browser.previewMap")}</button>
        </div>
      )}
    </section>
  );
}
