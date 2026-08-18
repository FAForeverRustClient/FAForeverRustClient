import { Fragment, useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { PlayerName } from "../../shared/nameColors";
import { ipc } from "../../ipc/client";
import type { CoopMission, Game } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { GameFiltersModal, type GameFilterRule } from "./GameFiltersModal";
import { HostGameModal } from "./HostGameModal";
import { MatchmakingPanel } from "./MatchmakingPanel";
import { CoopPanel } from "./CoopPanel";
import { GalacticWarPanel } from "./GalacticWarPanel";
import { CustomGamesBrowser, type GameViewMode } from "./CustomGamesBrowser";
import { CustomGamesToolbar, type SortMode } from "./CustomGamesToolbar";
import { GameMapImage } from "./GameMapImage";
import { PlayModeTabs } from "./PlayModeTabs";
import { PrivateGameDialog } from "./PrivateGameDialog";
import { findVaultMap, isGeneratedMap, mapPresentation } from "../../shared/mapPresentation";
import "./custom-games.css";
import "./game-dialogs.css";
import "./play.css";
import { useTranslation } from "../../i18n/useTranslation";

const connect = () => ipc.send({ kind: "Lobby", command: { type: "connect" } });
const join = (id: number, password: string | null = null) => ipc.send({ kind: "Lobby", command: { type: "join", payload: { id, password } } });

function matchesRule(game: Game, rule: GameFilterRule) {
  const raw = rule.field === "title" ? game.title : rule.field === "host" ? game.host : rule.field === "map" ? game.map : rule.field === "mod" ? game.modName : game.averageRating;
  if (rule.field === "rating") {
    const target = Number(rule.value);
    if (!Number.isFinite(target)) return false;
    if (rule.constraint === "above") return Number(raw) > target;
    if (rule.constraint === "below") return Number(raw) < target;
    if (rule.constraint === "notEquals") return Number(raw) !== target;
    return Number(raw) === target;
  }
  const value = String(raw).toLocaleLowerCase();
  const target = rule.value.toLocaleLowerCase();
  if (rule.constraint === "starts") return value.startsWith(target);
  if (rule.constraint === "ends") return value.endsWith(target);
  if (rule.constraint === "equals") return value === target;
  if (rule.constraint === "notEquals") return value !== target;
  return value.includes(target);
}

function compareGames(sort: SortMode, left: Game, right: Game): number {
  switch (sort) {
    case "players":
      return right.players - left.players;
    case "rating":
      return right.averageRating - left.averageRating;
    case "map":
      return left.map.localeCompare(right.map);
    case "host":
      return left.host.localeCompare(right.host);
    case "age":
      return (right.hostedAt ?? "").localeCompare(left.hostedAt ?? "");
  }
}

function GameDetails({ game, onJoin }: { game: Game; onJoin: () => void }) {
  const { t } = useTranslation();
  const maps = useAppStore((state) => state.state.maps);
  const lobby = useAppStore((state) => state.state.lobby);
  const player = useAppStore((state) => state.state.auth.player);
  const mapGenStatus = useAppStore((state) => state.state.mapGenerator.status);
  const vaultMap = findVaultMap(maps.vault, game.map);
  const presentation = mapPresentation(maps.vault, game.map);
  const isGenerated = isGeneratedMap(game.map);
  const installed = maps.installed.some((map) => map.folderName.toLowerCase() === game.map.toLowerCase() || map.folderName.toLowerCase().startsWith(`${game.map.toLowerCase()}.`));
  const isGeneratingThisMap =
    mapGenStatus.type === "generating" ||
    mapGenStatus.type === "downloading" ||
    mapGenStatus.type === "resolvingVersion";
  const teams = Object.entries(game.teams).filter(([, players]) => players.length > 0);
  const simMods = Object.values(game.simMods);

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
    <aside className="game-detail-panel surface-panel">
      <div className="game-map-preview">
        <GameMapImage
          mapName={game.map}
          vault={maps.vault}
          className="game-detail-map-image"
          placeholderClassName="map-preview-placeholder"
          large
        />
        {game.passwordProtected && (
          <span className="private-badge" role="img" aria-label={t("lobby.details.privateGame")} title={t("lobby.details.privateGame")}>
            <Icon name="lock" size={13} />
          </span>
        )}
      </div>
      <div className="game-detail-content">
        <div className="game-detail-title"><span>{game.modName || "faf"}</span><h2>{game.title}</h2><p>{t("lobby.details.hostLabel")} <PlayerName name={game.host} /></p></div>
        <dl className="game-summary-list">
          <div><dt>{t("lobby.details.map")}</dt><dd>{presentation.displayName}</dd></div>
          <div><dt>{t("lobby.details.players")}</dt><dd>{game.players} / {game.maxPlayers}</dd></div>
          <div><dt>{t("lobby.details.averageRating")}</dt><dd>{game.averageRating || t("lobby.details.unrated")}</dd></div>
          <div><dt>{t("lobby.details.ratingRange")}</dt><dd>{game.ratingMin !== null || game.ratingMax !== null ? `${game.ratingMin ?? t("lobby.details.any")} – ${game.ratingMax ?? t("lobby.details.any")}` : t("lobby.details.open")}</dd></div>
          <div><dt>{t("lobby.details.visibility")}</dt><dd>{game.visibility || t("lobby.details.public")}</dd></div>
        </dl>
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
            {isGeneratingThisMap ? t("lobby.details.generatingMap") : t("lobby.details.generateMap")}
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
            {t("lobby.details.downloadMap")}
          </Button>
        )}
        {simMods.length > 0 && (
          <div className="game-detail-section">
            <h3>{t("lobby.details.simMods")}</h3>
            {simMods.map((mod) => <span className="tag" key={mod}>{mod}</span>)}
          </div>
        )}
        {teams.length > 0 && (
          <div className="game-detail-section">
            {teams.map(([team, players]) => (
              <div className="game-team" key={team}>
                <span>{team === "-1" || team === "null" ? t("lobby.details.observers") : t("lobby.details.team", { id: team })}</span>
                <small>
                  {players.map((p, i) => (
                    <Fragment key={p}>
                      {i > 0 && ", "}
                      <PlayerName name={p} />
                    </Fragment>
                  ))}
                </small>
              </div>
            ))}
          </div>
        )}
        <Button className="game-detail-join" variant="primary" disabled={joinDisabled} title={joinTitle} onClick={onJoin}>{joinLabel}</Button>
      </div>
    </aside>
  );
}

export function LobbyView() {
  const { t } = useTranslation();
  const lobby = useAppStore((state) => state.state.lobby);
  const maps = useAppStore((state) => state.state.maps);
  const galacticWar = useAppStore((state) => state.state.galacticWar);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const gameBrowser = browsing.customGamesBrowser;
  const [search, setSearch] = useState("");
  const sort: SortMode = gameBrowser.sort;
  const gameView: GameViewMode = browsing.customGamesView;
  const hidePrivate = gameBrowser.hidePrivate;
  const hideModded = gameBrowser.hideModded;
  const applyFilters = gameBrowser.applyFilters;
  const rules: GameFilterRule[] = gameBrowser.rules;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);
  const [passwordGame, setPasswordGame] = useState<Game | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (useAppStore.getState().state.lobby.status === "disconnected") connect();
    ipc.send({ kind: "Maps", command: { type: "loadInstalled" } });
    // Only when nothing has loaded it yet: this tab mounts on every visit, and
    // the vault is the catalogue crawl. The service refuses a second one
    // anyway; this just saves the round trip, and matches every other caller.
    if (useAppStore.getState().state.maps.vaultStatus.type === "idle") {
      ipc.send({ kind: "Maps", command: { type: "loadVault" } });
    }
  }, []);

  const customGames = useMemo(() => lobby.games.filter((game) => game.modName.toLocaleLowerCase() !== "coop" && game.gameType.toLocaleLowerCase() !== "coop"), [lobby.games]);
  const coopGames = useMemo(() => lobby.games.filter((game) => game.modName.toLocaleLowerCase() === "coop" || game.gameType.toLocaleLowerCase() === "coop"), [lobby.games]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return customGames
      .slice()
      .filter((game) => !query || [game.title, game.host, game.map, game.modName].some((value) => value.toLocaleLowerCase().includes(query)))
      .filter((game) => !hidePrivate || !game.passwordProtected)
      .filter((game) => !hideModded || Object.keys(game.simMods).length === 0)
      .filter((game) => !applyFilters || !rules.some((rule) => matchesRule(game, rule)))
      .sort((left, right) => compareGames(sort, left, right));
  }, [applyFilters, customGames, hideModded, hidePrivate, rules, search, sort]);

  const filteredCoopGames = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return coopGames
      .slice()
      .filter((game) => !query || [game.title, game.host, game.map, game.modName].some((value) => value.toLocaleLowerCase().includes(query)))
      .filter((game) => !hidePrivate || !game.passwordProtected)
      .filter((game) => !hideModded || Object.keys(game.simMods).length === 0)
      .filter((game) => !applyFilters || !rules.some((rule) => matchesRule(game, rule)))
      .sort((left, right) => compareGames(sort, left, right));
  }, [applyFilters, coopGames, hideModded, hidePrivate, rules, search, sort]);

  const selected = filtered.find((game) => game.id === selectedId) ?? filtered[0] ?? null;
  const connected = lobby.status === "connected";
  const inMatchmaker = lobby.playMode === "matchmaking";
  const inCoop = lobby.playMode === "coop";
  const inGalacticWar = lobby.playMode === "galacticWar";

  const requestJoin = (game: Game) => {
    if (game.passwordProtected) {
      setPassword("");
      setPasswordGame(game);
    } else join(game.id);
  };

  const selectGameView = (view: GameViewMode) => {
    ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: { preferences: { ...browsing, customGamesView: view } },
      },
    });
  };

  const updateGameBrowser = (changes: Partial<typeof gameBrowser>) => {
    ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: {
          preferences: {
            ...browsing,
            customGamesBrowser: { ...gameBrowser, ...changes },
          },
        },
      },
    });
  };

  const [coopMissionToHost, setCoopMissionToHost] = useState<CoopMission | null>(null);

  const handleHostCoop = (mission?: CoopMission) => {
    setCoopMissionToHost(mission ?? null);
    setHostOpen(true);
  };

  return (
    <div className="play-view">
      {/* Join and launch progress now lives in the status bar beside the FAF
          and Chat indicators (`GameJoinStatus`), rather than as a banner that
          pushed the whole workspace down for one line of text. */}
      <PlayModeTabs
        mode={lobby.playMode}
        customGames={customGames.length}
        queues={lobby.matchmakerQueues.length}
        coopGames={coopGames.length}
        galacticWarOnline={galacticWar.statistics?.season?.numOnlinePlayers ?? 0}
        onChange={(mode) =>
          ipc.send({
            kind: "Lobby",
            command: { type: "setPlayMode", payload: { mode } },
          })
        }
      />

      {inMatchmaker ? (
        <MatchmakingPanel
          queues={lobby.matchmakerQueues}
          matchmaking={lobby.matchmaking}
          party={lobby.party}
        />
      ) : inCoop ? (
        <CoopPanel
          games={filteredCoopGames}
          viewMode={gameView}
          toolbar={(
            <CustomGamesToolbar
              search={search}
              sort={sort}
              viewMode={gameView}
              hidePrivate={hidePrivate}
              hideModded={hideModded}
              applyFilters={applyFilters}
              filterCount={rules.length}
              connected={connected}
              onSearch={setSearch}
              onSort={(value) => updateGameBrowser({ sort: value })}
              onViewMode={selectGameView}
              onHidePrivate={(value) => updateGameBrowser({ hidePrivate: value })}
              onHideModded={(value) => updateGameBrowser({ hideModded: value })}
              onApplyFilters={(value) => updateGameBrowser({ applyFilters: value })}
              onOpenFilters={() => setFiltersOpen(true)}
              onHost={() => handleHostCoop()}
              onRefresh={() => ipc.send({ kind: "Coop", command: { type: "loadCatalog" } })}
            />
          )}
          onJoin={requestJoin}
          onHost={handleHostCoop}
        />
      ) : inGalacticWar ? (
        <GalacticWarPanel />
      ) : (
        <div className="custom-games-layout">
          <CustomGamesToolbar
            search={search}
            sort={sort}
            viewMode={gameView}
            hidePrivate={hidePrivate}
            hideModded={hideModded}
            applyFilters={applyFilters}
            filterCount={rules.length}
            connected={connected}
            onSearch={setSearch}
            onSort={(value) => updateGameBrowser({ sort: value })}
            onViewMode={selectGameView}
            onHidePrivate={(value) => updateGameBrowser({ hidePrivate: value })}
            onHideModded={(value) => updateGameBrowser({ hideModded: value })}
            onApplyFilters={(value) => updateGameBrowser({ applyFilters: value })}
            onOpenFilters={() => setFiltersOpen(true)}
            onHost={() => {
              setCoopMissionToHost(null);
              setHostOpen(true);
            }}
          />

          <CustomGamesBrowser
            games={filtered}
            totalGames={customGames.length}
            selectedId={selected?.id ?? null}
            vault={maps.vault}
            viewMode={gameView}
            onSelect={setSelectedId}
            onJoin={requestJoin}
          />
          {selected ? (
            <GameDetails game={selected} onJoin={() => requestJoin(selected)} />
          ) : (
            <aside className="game-detail-panel surface-panel empty">
              <Icon name="play" size={24} />
              <p>{t("lobby.details.selectGame")}</p>
            </aside>
          )}
        </div>
      )}

      {filtersOpen && <GameFiltersModal rules={rules} onChange={(nextRules) => updateGameBrowser({ rules: nextRules })} onClose={() => setFiltersOpen(false)} />}
      {hostOpen && (
        <HostGameModal
          forcedFeaturedMod={inCoop ? "coop" : undefined}
          initialMap={coopMissionToHost?.mapFolderName}
          initialTitle={coopMissionToHost ? `${coopMissionToHost.name} co-op` : undefined}
          onClose={() => {
            setHostOpen(false);
            setCoopMissionToHost(null);
          }}
        />
      )}
      {passwordGame && (
        <PrivateGameDialog
          game={passwordGame}
          password={password}
          onPassword={setPassword}
          onCancel={() => setPasswordGame(null)}
          onSubmit={() => {
            join(passwordGame.id, password);
            setPasswordGame(null);
          }}
        />
      )}
    </div>
  );
}
