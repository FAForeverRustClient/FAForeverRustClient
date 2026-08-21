import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { PlayerName } from "../../shared/nameColors";
import { ipc } from "../../ipc/client";
import type { CoopMission, Game, PlayerProfile, VaultMap } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { GameFiltersModal, type GameFilterRule } from "./GameFiltersModal";
import { HostGameModal } from "./HostGameModal";
import { HostCoopModal } from "./host/HostCoopModal";
import { MatchmakingPanel } from "./MatchmakingPanel";
import { CoopPanel } from "./CoopPanel";
import { GalacticWarPanel } from "./GalacticWarPanel";
import { CustomGamesBrowser, type GameViewMode } from "./CustomGamesBrowser";
import { CustomGamesToolbar, type SortMode } from "./CustomGamesToolbar";
import { GameMapImage } from "./GameMapImage";
import { PlayModeTabs } from "./PlayModeTabs";
import { PrivateGameDialog } from "./PrivateGameDialog";
import { findVaultMap, isGeneratedMap, mapPresentation } from "../../shared/mapPresentation";
import { openPlayerCard } from "../player-card/playerCardActions";
import { PlayerNoteModal } from "../player-card/PlayerNoteEditor";
import { UserMenu, type UserMenuTarget } from "../chat/UserMenu";
import { findPlayer } from "../../store/reducer";
import { assignedPlayerColor, includesName, nickKey } from "../../shared/nameColorsUtil";
import { noteForPlayer } from "../../shared/playerNotes";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import "./custom-games.css";
import "./game-dialogs.css";
import "./play.css";
import { useTranslation } from "../../i18n/useTranslation";

const connect = () => ipc.send({ kind: "Lobby", command: { type: "connect" } });
const join = (id: number, password: string | null = null) => ipc.send({ kind: "Lobby", command: { type: "join", payload: { id, password } } });

function matchesRule(game: Game, rule: GameFilterRule, vault: VaultMap[]) {
  if (rule.field === "rating") {
    const target = Number(rule.value);
    if (!Number.isFinite(target)) return false;
    if (rule.constraint === "above") return Number(game.averageRating) > target;
    if (rule.constraint === "below") return Number(game.averageRating) < target;
    if (rule.constraint === "notEquals") return Number(game.averageRating) !== target;
    return Number(game.averageRating) === target;
  }
  const target = rule.value.replace(/^["']|["']$/g, "").trim().toLocaleLowerCase();
  if (!target) return false;

  const testString = (val: string) => {
    const value = val.toLocaleLowerCase();
    if (rule.constraint === "starts") return value.startsWith(target);
    if (rule.constraint === "ends") return value.endsWith(target);
    if (rule.constraint === "equals") return value === target;
    if (rule.constraint === "notEquals") return value !== target;
    return value.includes(target);
  };

  if (rule.field === "title") {
    return testString(game.title);
  }
  if (rule.field === "host") {
    return testString(game.host);
  }
  if (rule.field === "map") {
    const mapDisplay = mapPresentation(vault, game.map).displayName;
    return testString(game.map) || testString(mapDisplay);
  }
  if (rule.field === "titleOrMap") {
    const mapDisplay = mapPresentation(vault, game.map).displayName;
    return testString(game.title) || testString(game.map) || testString(mapDisplay);
  }
  if (rule.field === "mod") {
    return testString(game.modName);
  }
  return false;
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

function GameDetails({
  game,
  onJoin,
  onOpenUserMenu,
}: {
  game: Game;
  onJoin: () => void;
  onOpenUserMenu: (nickname: string, event: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const maps = useAppStore((state) => state.state.maps);
  const lobby = useAppStore((state) => state.state.lobby);
  const social = useAppStore((state) => state.state.social);
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

  const hostProfile = findPlayer(social, game.host);

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
        <div className="game-detail-title">
          <span>{game.modName || "faf"}</span>
          <h2>{game.title}</h2>
          <p>
            {t("lobby.details.hostLabel")}{" "}
            <button
              type="button"
              className="game-team-player"
              onClick={() => openPlayerCard(hostProfile?.id ?? null, game.host)}
              onContextMenu={(e) => onOpenUserMenu(game.host, e)}
              title={`Open ${game.host}'s profile`}
            >
              <PlayerName name={game.host} />
            </button>
          </p>
        </div>
        <dl className="game-summary-list">
          <div><dt>{t("lobby.details.map")}</dt><dd>{presentation.displayName}</dd></div>
          <div><dt>{t("lobby.details.players")}</dt><dd>{game.players} / {game.maxPlayers}</dd></div>
          <div><dt>{t("lobby.details.averageRating")}</dt><dd>{game.averageRating || t("lobby.details.unrated")}</dd></div>
          <div><dt>{t("lobby.details.ratingRange")}</dt><dd>{game.ratingMin !== null || game.ratingMax !== null ? `${game.ratingMin ?? t("lobby.details.any")} – ${game.ratingMax ?? t("lobby.details.any")}` : t("lobby.details.open")}</dd></div>
          <div><dt>{t("lobby.details.visibility")}</dt><dd>{game.visibility || t("lobby.details.public")}</dd></div>
        </dl>
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
                  {players.map((p, i) => {
                    const profile = findPlayer(social, p);
                    return (
                      <Fragment key={p}>
                        {i > 0 && ", "}
                        <button
                          type="button"
                          className="game-team-player"
                          onClick={() => openPlayerCard(profile?.id ?? null, p)}
                          onContextMenu={(e) => onOpenUserMenu(p, e)}
                          title={`Open ${p}'s profile`}
                        >
                          <PlayerName name={p} />
                        </button>
                      </Fragment>
                    );
                  })}
                </small>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="game-detail-footer surface">
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
            <Icon name="plus" size={13} />
            {t("lobby.details.downloadMap")}
          </Button>
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
  const social = useAppStore((state) => state.state.social);
  const chatPreferences = useAppStore((state) => state.state.settings.chat);
  const player = useAppStore((state) => state.state.auth.player);
  const self = player?.name ?? "";
  const liveGames = useAppStore((state) => state.state.lobby.liveGames);
  const party = useAppStore((state) => state.state.lobby.party);
  const playerNotes = useAppStore((state) => state.state.settings.social.playerNotes);
  const galacticWar = useAppStore((state) => state.state.galacticWar);
  const selectedMissionId = useAppStore((state) => state.state.coop.selectedMissionId);
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
  const [menu, setMenu] = useState<UserMenuTarget | null>(null);
  const [noteTarget, setNoteTarget] = useState<PlayerProfile | null>(null);

  const openUserMenu = useCallback((nickname: string, event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({
      nickname,
      profile: findPlayer(useAppStore.getState().state.social, nickname),
      x: event.clientX,
      y: event.clientY,
    });
  }, []);
  const closeUserMenu = useCallback(() => setMenu(null), []);

  const openConversation = useCallback((user: string) => {
    if (!user) return;
    ipc.send({ kind: "Chat", command: { type: "joinChannel", payload: { channel: user } } });
    ipc.send({ kind: "Chat", command: { type: "selectChannel", payload: { channel: user } } });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "chat" } } });
  }, []);

  const setPlayerNameColor = useCallback((nickname: string, color: string | null) => {
    const preferences = useAppStore.getState().state.settings.chat;
    const key = nickKey(nickname);
    const players = Object.fromEntries(
      Object.entries(preferences.nameColors.players).filter(([p]) => nickKey(p) !== key),
    );
    if (color) players[nickname] = color;
    ipc.send({
      kind: "Settings",
      command: {
        type: "setChat",
        payload: {
          preferences: {
            ...preferences,
            nameColors: { ...preferences.nameColors, players },
          },
        },
      },
    });
  }, []);

  const setMuted = useCallback((nickname: string, muted: boolean) => {
    const preferences = useAppStore.getState().state.settings.chat;
    const withoutPlayer = preferences.mutedPlayers.filter(
      (p) => p.localeCompare(nickname, undefined, { sensitivity: "accent" }) !== 0,
    );
    ipc.send({
      kind: "Settings",
      command: {
        type: "setChat",
        payload: {
          preferences: {
            ...preferences,
            mutedPlayers: muted ? [...withoutPlayer, nickname] : withoutPlayer,
          },
        },
      },
    });
  }, []);

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
      .filter(
        (game) =>
          !query ||
          [
            game.title,
            game.host,
            game.map,
            mapPresentation(maps.vault, game.map).displayName,
            game.modName,
          ].some((value) => value.toLocaleLowerCase().includes(query)),
      )
      .filter((game) => !hidePrivate || !game.passwordProtected)
      .filter((game) => !hideModded || Object.keys(game.simMods).length === 0)
      .filter((game) => !applyFilters || !rules.some((rule) => matchesRule(game, rule, maps.vault)))
      .sort((left, right) => compareGames(sort, left, right));
  }, [applyFilters, customGames, hideModded, hidePrivate, maps.vault, rules, search, sort]);

  const filteredCoopGames = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return coopGames
      .slice()
      .filter(
        (game) =>
          !query ||
          [
            game.title,
            game.host,
            game.map,
            mapPresentation(maps.vault, game.map).displayName,
            game.modName,
          ].some((value) => value.toLocaleLowerCase().includes(query)),
      )
      .filter((game) => !hidePrivate || !game.passwordProtected)
      .filter((game) => !hideModded || Object.keys(game.simMods).length === 0)
      .filter((game) => !applyFilters || !rules.some((rule) => matchesRule(game, rule, maps.vault)))
      .sort((left, right) => compareGames(sort, left, right));
  }, [applyFilters, coopGames, hideModded, hidePrivate, maps.vault, rules, search, sort]);

  const selected = filtered.find((game) => game.id === selectedId) ?? filtered[0] ?? null;
  const inGame = (list: Game[], nickname: string) =>
    list.find((g) => Object.values(g.teams).some((team) => team.includes(nickname)));
  const menuHostedGame = menu && customGames.find((g) => g.host === menu.nickname);
  const menuLiveGame = menu ? inGame(liveGames, menu.nickname) : undefined;
  const inParty = (id: number) => party.members.some((m) => m.playerId === id);
  const menuNameColor = menu
    ? assignedPlayerColor(chatPreferences.nameColors.players, menu.nickname)
    : undefined;
  const menuIsMuted = !!menu && includesName(chatPreferences.mutedPlayers, menu.nickname);

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
    const current = useAppStore.getState().state.settings.browsing;
    ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: {
          preferences: {
            ...current,
            customGamesBrowser: { ...current.customGamesBrowser, ...changes },
          },
        },
      },
    });
  };

  // Which mission the co-op dialog should open on. `undefined` means "whatever
  // the leaderboard is showing", which is the case when the toolbar button is
  // used rather than a specific mission.
  const [coopMissionToHost, setCoopMissionToHost] = useState<CoopMission | null>(null);
  // A title another tab prepared, e.g. the tournament tab offering to host a
  // bracket match. It lives in the lobby slice because it has to cross a tab
  // boundary; opening the dialog when one arrives is the whole handling.
  const hostPrefill = useAppStore((store) => store.state.lobby.hostPrefill);
  useEffect(() => {
    if (hostPrefill !== null) setHostOpen(true);
  }, [hostPrefill]);

  const handleHostCoop = (mission?: CoopMission) => {
    setCoopMissionToHost(mission ?? null);
    setHostOpen(true);
  };

  const closeHostDialog = () => {
    setHostOpen(false);
    setCoopMissionToHost(null);
    // Otherwise the dialog reopens the next time this tab is visited.
    if (hostPrefill !== null) {
      ipc.send({ kind: "Lobby", command: { type: "clearHostPrefill" } });
    }
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
            <GameDetails game={selected} onJoin={() => requestJoin(selected)} onOpenUserMenu={openUserMenu} />
          ) : (
            <aside className="game-detail-panel surface-panel empty">
              <Icon name="play" size={24} />
              <p>{t("lobby.details.selectGame")}</p>
            </aside>
          )}
        </div>
      )}

      {filtersOpen && (
        <GameFiltersModal
          rules={rules}
          applyFilters={applyFilters}
          onApplyFiltersChange={(value) => updateGameBrowser({ applyFilters: value })}
          onChange={(nextRules) =>
            updateGameBrowser({
              rules: nextRules,
              applyFilters: nextRules.length > 0 ? true : applyFilters,
            })
          }
          onClose={() => setFiltersOpen(false)}
        />
      )}
      {hostOpen &&
        (inCoop ? (
          // Co-op hosts a campaign mission, not a map: its own dialog, with the
          // campaigns where the custom one asks for a featured mod.
          <HostCoopModal
            initialMissionId={coopMissionToHost?.id ?? selectedMissionId}
            initialTitle={hostPrefill ?? undefined}
            onClose={closeHostDialog}
          />
        ) : (
          <HostGameModal initialTitle={hostPrefill ?? undefined} onClose={closeHostDialog} />
        ))}
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

      {menu && (
        <UserMenu
          target={menu}
          self={self}
          isFriend={social.friends.includes(menu.nickname)}
          isFoe={social.foes.includes(menu.nickname)}
          isMuted={menuIsMuted}
          hostedGame={menuHostedGame ?? undefined}
          liveGame={menuLiveGame}
          canInvite={!!menu.profile && !inParty(menu.profile.id)}
          canKickFromParty={
            !!menu.profile &&
            party.ownerId === (player?.id ?? -1) &&
            inParty(menu.profile.id)
          }
          nameColor={menuNameColor}
          actions={{
            privateMessage: openConversation,
            viewProfile: (playerId, nickname) => void openPlayerCard(playerId, nickname),
            copyUsername: (nickname) => void navigator.clipboard?.writeText(nickname),
            joinGame: (game) => void requestJoin(game),
            watchGame: (game) =>
              ipc.send({
                kind: "Replays",
                command: { type: "watchLive", payload: { uid: game.id, modName: game.modName, map: game.map } },
              }),
            viewReplays: (username) => {
              ipc.send({
                kind: "Replays",
                command: {
                  type: "searchVault",
                  payload: { query: { ...EMPTY_REPLAY_QUERY, player: username, exactPlayer: true } },
                },
              });
              ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
            },
            inviteToParty: (id) =>
              ipc.send({ kind: "Lobby", command: { type: "inviteToParty", payload: { playerId: id } } }),
            setRelation: (profile, relation, member) =>
              ipc.send({
                kind: "Social",
                command: {
                  type: "setRelation",
                  payload: { playerId: profile.id, login: profile.login, relation, member },
                },
              }),
            kickFromParty: (id) =>
              ipc.send({ kind: "Lobby", command: { type: "kickPartyMember", payload: { playerId: id } } }),
            setNameColor: setPlayerNameColor,
            setMuted,
            editNote: setNoteTarget,
            reportPlayer: (profile) =>
              ipc.send({
                kind: "Reporting",
                command: { type: "open", payload: { playerId: profile.id, login: profile.login } },
              }),
          }}
          onClose={closeUserMenu}
        />
      )}
      {noteTarget && (
        <PlayerNoteModal
          playerId={noteTarget.id}
          login={noteTarget.login}
          initialNote={noteForPlayer(playerNotes, noteTarget.id)}
          onClose={() => setNoteTarget(null)}
        />
      )}
    </div>
  );
}
