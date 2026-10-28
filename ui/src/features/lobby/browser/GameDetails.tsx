// The panel beside the game list: the picked game's map, facts, mods and
// lineup, and the button that joins it.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { StatusNotice } from "../../../design-system/StatusNotice";
import { playingCount } from "../../../shared/gameRules";
import { PlayerName } from "../../../shared/components/nameColors";
import { PlayerNoteMark } from "../../../shared/components/PlayerNoteMark";
import { noteForPlayer } from "../../../shared/rules/playerNotes";
import { ipc } from "../../../ipc/client";
import type { Game } from "../../../ipc/bindings";
import { useAppStore } from "../../../store/store";
import { displayTeamName } from "./GameLineup";
import { GameMapImage } from "../GameMapImage";
import { requestModVaultFocus } from "../../../shared/modVaultFocus";
import { flagSrc } from "../../../shared/countryFlags";
import {
  GLOBAL_LEADERBOARD,
  averageRating,
  displayedRating,
  gameLeaderboard,
  leaderboardLabel,
} from "../../../shared/playerRatings";
import { useCountryLabel } from "../../../shared/hooks/useCountryLabel";
import { isGeneratedMap, mapPresentation, mapSize } from "../../../shared/mapPresentation";
import { openPlayerCard } from "../../../shared/playerCardActions";
import { findPlayer } from "../../../store/reducer";
import { splitGoAdapterTitle } from "../../../shared/goAdapterTitle";
import { useTranslation } from "../../../i18n/useTranslation";
import { plainError } from "../../../shared/plainError";
import { boundsText } from "../../../shared/ratingBounds";

export function GameDetails({
  game,
  onJoin,
  onOpenUserMenu,
  onPreview,
}: {
  game: Game;
  onJoin: () => void;
  onOpenUserMenu: (nickname: string, event: React.MouseEvent) => void;
  onPreview?: () => void;
}) {
  const countryOf = useCountryLabel();
  const { t } = useTranslation();
  const maps = useAppStore((state) => state.state.maps);
  const lobby = useAppStore((state) => state.state.lobby);
  const social = useAppStore((state) => state.state.social);
  const playerNotes = useAppStore((state) => state.state.settings.social.playerNotes);
  const player = useAppStore((state) => state.state.auth.player);
  const presentation = mapPresentation(maps.vault, game.map);
  const mapGenStatus = useAppStore((state) => state.state.mapGenerator.status);
  const isGenerated = isGeneratedMap(game.map);
  // How big the map is, which the lobby's game record does not carry: the
  // vault knows it for anything uploaded, the built-in table for the
  // base-game maps that are not vault records, and a generated map's own
  // name, which encodes it. Decoding that name is one command for the one
  // game this panel is showing, the same request the preview dialog makes.
  const decoded = useAppStore((state) => state.state.mapGenerator.decoded?.[game.map]);
  useEffect(() => {
    if (!isGenerated || decoded) return;
    ipc.send({
      kind: "MapGenerator",
      command: { type: "decodeNames", payload: { mapNames: [game.map] } },
    });
  }, [isGenerated, decoded, game.map]);
  const size = mapSize(maps.vault, game.map, decoded?.mapSize);
  const mapInstalled = maps.installed.some(
    (map) =>
      map.folderName.toLowerCase() === game.map.toLowerCase() ||
      map.folderName.toLowerCase().startsWith(`${game.map.toLowerCase()}.`),
  );
  const isGeneratingThisMap =
    mapGenStatus.type === "generating" ||
    mapGenStatus.type === "downloading" ||
    mapGenStatus.type === "resolvingVersion";
  const teams = useMemo(() => {
    return Object.entries(game.teams)
      .filter(([, players]) => players.length > 0)
      .sort(([a], [b]) => {
        if (a === "-1" || a === "null") return 1;
        if (b === "-1" || b === "null") return -1;
        const numA = Number(a);
        const numB = Number(b);
        if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
        return a.localeCompare(b);
      });
  }, [game.teams]);
  // Every rating in this panel, the headline average included, is the one
  // this game is rated on. A ladder lobby listing global ratings is the
  // number the game is not about.
  const leaderboard = gameLeaderboard(game.ratingType);
  const simMods = Object.entries(game.simMods);
  const [expandedMods, setExpandedMods] = useState(false);
  useEffect(() => {
    setExpandedMods(false);
  }, [game.id]);

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

  // A join this game refused, said here, beside the button that tries again.
  // It was an 11 px line in the status bar, in English, with no way out.
  const failedHere = lobby.join.type === "failed" && lobby.join.payload.id === game.id
    ? plainError(lobby.join.payload.reason)
    : null;

  let joinLabel = failedHere ? t("lobby.details.joinAgain") : t("lobby.details.joinGame");
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

  const hostProfile = findPlayer(social, game.host);

  // The same jump the preview dialog offers, here in the sidebar: a player
  // reading the mod list should not have to open the map preview first to find
  // out what one of these mods is.
  const openModInVault = (mod: string) => {
    requestModVaultFocus(mod);
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "mods" } } });
  };

  return (
    <aside className="game-detail-panel surface-panel">
      <div className="game-map-preview-wrap">
        <button
          type="button"
          className="game-map-preview"
          onClick={onPreview}
          title={t("lobby.browser.previewMap")}
          aria-label={t("lobby.browser.previewMap")}
        >
          <GameMapImage
            mapName={game.map}
            vault={maps.vault}
            className="game-detail-map-image"
            placeholderClassName="map-preview-placeholder"
            large
          />
          {game.passwordProtected && (
            <span className="private-badge" role="img" aria-label={t("lobby.details.privateGame")} title={t("lobby.details.privateGame")}>
              <Icon name="lock" size={16} />
            </span>
          )}
        </button>
        {!mapInstalled && isGenerated && (
          <Button
            className="game-map-preview-action"
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
      </div>
      <div className="game-detail-content">
        <div className="game-detail-title">
          <h2>{splitGoAdapterTitle(game.title).title}</h2>
          <p>
            {t("lobby.details.hostLabel")}{" "}
            <button
              type="button"
              className="game-team-player"
              onClick={() => openPlayerCard(hostProfile?.id ?? null, game.host)}
              onContextMenu={(e) => onOpenUserMenu(game.host, e)}
              title={t("lobby.browser.openProfile", { name: game.host })}
            >
              <PlayerName name={game.host} />
            </button>
          </p>
        </div>
        <dl className="game-summary-list">
          <div><dt>{t("lobby.details.map")}</dt><dd>{presentation.displayName}</dd></div>
          {/* Only where one of the three sources actually knows it. A row
              reading 10 km because that is the commonest size would be worse
              than no row: this is a number somebody is deciding on. */}
          {size && <div><dt>{t("lobby.details.mapSize")}</dt><dd>{size.full}</dd></div>}
          <div><dt>{t("lobby.details.players")}</dt><dd>{playingCount(game)} / {game.maxPlayers}</dd></div>
          {/* Named where it is not the global board, because a row reading
              "583" is not checkable against anything until it says which
              ladder it is 583 on. */}
          <div>
            <dt>{t("lobby.details.averageRating")}</dt>
            <dd>
              {game.averageRating || t("lobby.details.unrated")}
              {leaderboard !== GLOBAL_LEADERBOARD && (
                <small className="game-detail-leaderboard"> {leaderboardLabel(leaderboard)}</small>
              )}
            </dd>
          </div>
          <div><dt>{t("lobby.details.ratingRange")}</dt><dd>{boundsText(game.ratingMin, game.ratingMax) ?? t("lobby.details.open")}</dd></div>
        </dl>
        {simMods.length > 0 && (
          <div className="game-detail-section">
            <h3>{t("lobby.details.simMods")}</h3>
            <div className="game-detail-tags">
              {(expandedMods ? simMods : simMods.slice(0, 4)).map(([uid, mod]) => (
                <button
                  type="button"
                  className="tag tag-action"
                  key={uid}
                  title={t("lobby.details.openModInVault", { mod })}
                  onClick={() => openModInVault(mod)}
                >
                  {mod}
                </button>
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
          <div className="game-detail-section">
            {teams.map(([team, players]) => {
              const isObserver = team === "-1" || team === "null";
              const playerRatings = players.map((p) =>
                displayedRating(findPlayer(social, p), leaderboard),
              );
              const known = playerRatings.filter((r): r is number => r !== null);
              const totalRating = known.length > 0
                ? known.reduce((sum, r) => sum + r, 0)
                : null;
              const avgRating = averageRating(playerRatings);
              // A one-player team has no average and no total: both are the
              // rating already printed on that player's own row, two inches
              // to the right. A free-for-all is a column of these, and the
              // stats it grew were the same number said three times.
              const showsStats = !isObserver && totalRating !== null && players.length > 1;
              return (
                <div className="game-team" key={team}>
                  <div className="game-team-header">
                    <span className="game-team-name">
                      {displayTeamName(team, teams.length === 1)}
                    </span>
                    {showsStats && (
                      <span className="game-team-stats">
                        {t("lobby.details.teamStats", { average: avgRating ?? "", total: totalRating ?? "" })}
                      </span>
                    )}
                  </div>
                <ul className="game-team-player-list">
                  {players.map((p) => {
                    const profile = findPlayer(social, p);
                    const rating = displayedRating(profile, leaderboard);
                    return (
                      <li key={p} className="game-preview-player-row">
                        {profile?.country ? (
                          <img
                            src={flagSrc(profile.country)}
                            alt={countryOf(profile.country)}
                            title={countryOf(profile.country)}
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
                          onClick={() => openPlayerCard(profile?.id ?? null, p)}
                          onContextMenu={(e) => onOpenUserMenu(p, e)}
                          title={t("lobby.browser.openProfile", { name: p })}
                        >
                          <PlayerName name={p} />
                        </button>
                        <PlayerNoteMark note={profile ? noteForPlayer(playerNotes, profile.id) : undefined} />
                        {rating !== null && <span className="player-rating">{rating}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="game-detail-footer">
        {failedHere && (
          <StatusNotice tone="error" detail={lobby.join.type === "failed" ? lobby.join.payload.reason : undefined}>{t("lobby.details.joinFailed", { reason: failedHere })}</StatusNotice>
        )}
        <Button className="game-detail-join" variant="primary" disabled={joinDisabled} title={joinTitle} onClick={onJoin}>{joinLabel}</Button>
      </div>
    </aside>
  );
}
