import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import type { CoopMission, Game } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { GameFiltersModal, type GameFilterRule } from "./GameFiltersModal";
import { HostGameModal } from "./HostGameModal";
import { MatchmakingPanel } from "./MatchmakingPanel";
import { CoopPanel } from "./CoopPanel";
import { CustomGamesBrowser, type GameViewMode } from "./CustomGamesBrowser";
import { CustomGamesToolbar, type SortMode } from "./CustomGamesToolbar";
import { GameMapImage } from "./GameMapImage";
import { PlayModeTabs } from "./PlayModeTabs";
import { PrivateGameDialog } from "./PrivateGameDialog";
import { findVaultMap, mapPresentation } from "../../shared/mapPresentation";
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

function GameDetails({ game, joining, onJoin }: { game: Game; joining: boolean; onJoin: () => void }) {
  const { t } = useTranslation();
  const maps = useAppStore((state) => state.state.maps);
  const vaultMap = findVaultMap(maps.vault, game.map);
  const presentation = mapPresentation(maps.vault, game.map);
  const installed = maps.installed.some((map) => map.folderName === game.map || map.folderName.startsWith(`${game.map}.`));
  const teams = Object.entries(game.teams).filter(([, players]) => players.length > 0);
  const simMods = Object.values(game.simMods);

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
        <div className="game-detail-title"><span>{game.modName || "faf"}</span><h2>{game.title}</h2><p>{t("lobby.details.host", { name: game.host })}</p></div>
        <dl className="game-summary-list">
          <div><dt>{t("lobby.details.map")}</dt><dd>{presentation.displayName}</dd></div>
          <div><dt>{t("lobby.details.players")}</dt><dd>{game.players} / {game.maxPlayers}</dd></div>
          <div><dt>{t("lobby.details.averageRating")}</dt><dd>{game.averageRating || t("lobby.details.unrated")}</dd></div>
          <div><dt>{t("lobby.details.ratingRange")}</dt><dd>{game.ratingMin !== null || game.ratingMax !== null ? `${game.ratingMin ?? t("lobby.details.any")} – ${game.ratingMax ?? t("lobby.details.any")}` : t("lobby.details.open")}</dd></div>
          <div><dt>{t("lobby.details.visibility")}</dt><dd>{game.visibility || t("lobby.details.public")}</dd></div>
        </dl>
        {!installed && vaultMap && (
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
            <h3>{t("lobby.details.teams")}</h3>
            {teams.map(([team, players]) => (
              <div className="game-team" key={team}>
                <span>{team === "-1" || team === "null" ? t("lobby.details.observers") : t("lobby.details.team", { id: team })}</span>
                <small>{players.join(", ")}</small>
              </div>
            ))}
          </div>
        )}
        <Button className="game-detail-join" variant="primary" disabled={joining} onClick={onJoin}>{t(joining ? "lobby.details.joining" : "lobby.details.joinGame")}</Button>
      </div>
    </aside>
  );
}

export function LobbyView() {
  const { t } = useTranslation();
  const lobby = useAppStore((state) => state.state.lobby);
  const maps = useAppStore((state) => state.state.maps);
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
    ipc.send({ kind: "Maps", command: { type: "loadVault" } });
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return lobby.games
      .slice()
      .filter((game) => game.modName.toLocaleLowerCase() !== "coop" && game.gameType.toLocaleLowerCase() !== "coop")
      .filter((game) => !query || [game.title, game.host, game.map, game.modName].some((value) => value.toLocaleLowerCase().includes(query)))
      .filter((game) => !hidePrivate || !game.passwordProtected)
      .filter((game) => !hideModded || Object.keys(game.simMods).length === 0)
      .filter((game) => !applyFilters || !rules.some((rule) => matchesRule(game, rule)))
      .sort((left, right) => compareGames(sort, left, right));
  }, [applyFilters, hideModded, hidePrivate, lobby.games, rules, search, sort]);

  const selected = filtered.find((game) => game.id === selectedId) ?? filtered[0] ?? null;
  const connected = lobby.status === "connected";
  const joining = lobby.join.type === "joining" || lobby.join.type === "launched" || lobby.join.type === "preparing" || lobby.join.type === "inGame";
  const inMatchmaker = lobby.playMode === "matchmaking";
  const inCoop = lobby.playMode === "coop";
  const customGames = useMemo(() => lobby.games.filter((game) => game.modName.toLocaleLowerCase() !== "coop" && game.gameType.toLocaleLowerCase() !== "coop"), [lobby.games]);
  const coopGames = useMemo(() => lobby.games.filter((game) => game.modName.toLocaleLowerCase() === "coop" || game.gameType.toLocaleLowerCase() === "coop"), [lobby.games]);

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

  const hostMission = (mission: CoopMission) => ipc.send({
    kind: "Lobby",
    command: {
      type: "host",
      payload: {
        config: {
          title: `${mission.name} co-op`,
          modName: "coop",
          visibility: "public",
          map: mission.mapFolderName,
          password: null,
          enforceRatingRange: false,
          ratingMin: null,
          ratingMax: null,
        },
      },
    },
  });

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
        <CoopPanel games={coopGames} onJoin={requestJoin} onHost={hostMission} />
      ) : (
        <>
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
          onHost={() => setHostOpen(true)}
        />

        <div className="custom-games-layout">
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
            <GameDetails game={selected} joining={joining} onJoin={() => requestJoin(selected)} />
          ) : (
            <aside className="game-detail-panel surface-panel empty">
              <Icon name="play" size={24} />
              <p>{t("lobby.details.selectGame")}</p>
            </aside>
          )}
        </div>
        </>
      )}

      {filtersOpen && <GameFiltersModal rules={rules} onChange={(nextRules) => updateGameBrowser({ rules: nextRules })} onClose={() => setFiltersOpen(false)} />}
      {hostOpen && <HostGameModal forcedFeaturedMod={inCoop ? "coop" : undefined} onClose={() => setHostOpen(false)} />}
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
