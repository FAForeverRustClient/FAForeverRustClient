import { useEffect, useState } from "react";
import { ipc } from "../../ipc/client";
import type { Game } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { GameFiltersModal, type GameFilterRule } from "./browser/GameFiltersModal";
import { activeFilterCount } from "./browser/gameFilterRules";
import { useFilteredGames } from "./browser/useFilteredGames";
import { HostGameModal } from "./host/HostGameModal";
import { HostCoopModal } from "./host/HostCoopModal";
import { useHostDialog } from "./host/useHostDialog";
import { MatchmakingPanel } from "./matchmaker/MatchmakingPanel";
import { CoopPanel } from "./coop/CoopPanel";
import { GalacticWarPanel } from "./galactic-war/GalacticWarPanel";
import { Modal } from "../../design-system/Modal";
import { CustomGamesPanel } from "./browser/CustomGamesPanel";
import { GamePreviewDialog } from "./browser/GamePreviewDialog";
import { type GameViewMode } from "../../shared/gameRules";
import { CustomGamesToolbar, type SortMode } from "./browser/CustomGamesToolbar";
import { useDetailPanelLayout } from "./browser/useDetailPanelLayout";
import { PlayModeTabs, playModePanelProps } from "./PlayModeTabs";
import { queuedPlayerCount } from "./queuedPlayers";
import { PrivateGameDialog } from "./join/PrivateGameDialog";
import { usePlayerMenu } from "../../shared/hooks/usePlayerMenu";
import "./browser/custom-games.css";
import "./game-dialogs.css";
import "./play.css";
import { useLocale } from "../../i18n/useTranslation";
import { joinGame } from "../../shared/joinGame";
import { useForgetFiltersOnLeave, useRememberedFilter } from "../../shared/filterMemory";
import { DEFAULT_BROWSING_PREFERENCES } from "../../shared/browsingPreferences";
import { onlineCommanders } from "./galactic-war/galacticWarOnline";

/// How often the Galactic War player count is re-asked while the Play tab is
/// open. A minute: often enough that the number is not stale advice about
/// whether it is worth starting the other client, rare enough to be one small
/// request to a gateway that is not FAF's.
const GALACTIC_WAR_POLL_MS = 60_000;

const connect = () => ipc.send({ kind: "Lobby", command: { type: "connect" } });
const join = (id: number, password: string | null = null) => joinGame(id, password);

export function LobbyView() {
  // Redrawn on a language change, as it was while it translated its own
  // strings: the large preview below uses the module `t`, and is redrawn only
  // when this view is.
  useLocale();
  const lobby = useAppStore((state) => state.state.lobby);
  const maps = useAppStore((state) => state.state.maps);
  const social = useAppStore((state) => state.state.social);
  const galacticWar = useAppStore((state) => state.state.galacticWar);
  const selectedMissionId = useAppStore((state) => state.state.coop.selectedMissionId);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const mods = useAppStore((state) => state.state.mods);
  const gameBrowser = browsing.customGamesBrowser;
  const [search, setSearch] = useRememberedFilter("play.search", "");
  const sort: SortMode = gameBrowser.sort;
  const gameView: GameViewMode = browsing.customGamesView;
  const hidePrivate = gameBrowser.hidePrivate;
  const hideModded = gameBrowser.hideModded;
  const hideUnranked = gameBrowser.hideUnranked;
  const hideFoes = gameBrowser.hideFoes;
  const applyFilters = gameBrowser.applyFilters;
  const rules: GameFilterRule[] = gameBrowser.rules;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // A join that fails opens that game in the panel, where the reason and the
  // way to try again are. It is the game the player just asked to join, from
  // the list, a double-click or the preview, so this follows their action
  // rather than moving anything on its own.
  const failedJoinId = lobby.join.type === "failed" ? lobby.join.payload.id : null;
  useEffect(() => {
    if (failedJoinId !== null) setSelectedId(failedJoinId);
  }, [failedJoinId]);
  // The game the large preview was opened on, followed through the live list
  // while it is open: a snapshot kept showing the map the lobby had when the
  // dialog opened, however often the host changed it since (#384).
  const [previewSnapshot, setPreviewGame] = useState<Game | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [passwordGame, setPasswordGame] = useState<Game | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (useAppStore.getState().state.lobby.status === "disconnected") connect();
    ipc.send({ kind: "Maps", command: { type: "loadInstalled" } });
    // The two vaults are the catalogue crawls, loaded once per session: the
    // services refuse a second one, so this tab can ask on every visit.
    ipc.send({ kind: "Maps", command: { type: "loadVault" } });
    ipc.send({ kind: "Mods", command: { type: "loadVault" } });
    // What is on disk, which until now only the Mods tab and the host dialog
    // ever asked for. Joining is the other thing that needs the answer: a
    // player who had not opened either since starting the client was told to
    // download mods they had been playing with minutes earlier, because an
    // empty list and an unread list look the same from here.
    ipc.send({ kind: "Mods", command: { type: "loadInstalled" } });
  }, []);

  const { customGames, coopGames, filtered, filteredCoopGames } = useFilteredGames({
    games: lobby.games,
    search,
    gameBrowser,
    foes: social.foes,
    mapVault: maps.vault,
    modVault: mods.vault,
  });

  // Only ever the game the player picked. Falling back to the first row put a
  // different game under the Join button whenever the picked one closed,
  // launched or was filtered out, and with nothing picked the panel followed
  // whatever the live list sorted to the top. Both broke the rule that a
  // jumping list must never make a misclick join the wrong game.
  const selected =
    selectedId === null ? null : (filtered.find((game) => game.id === selectedId) ?? null);
  const previewGame = previewSnapshot
    ? customGames.find((game) => game.id === previewSnapshot.id)
      ?? coopGames.find((game) => game.id === previewSnapshot.id)
      ?? previewSnapshot
    : null;
  const connected = lobby.status === "connected";
  const inMatchmaker = lobby.playMode === "matchmaking";
  const inCoop = lobby.playMode === "coop";
  const inGalacticWar = lobby.playMode === "galacticWar";
  // The rules the Filters button stands for, while they are applied. The hide
  // switches sit beside it in the toolbar and show themselves.
  const filterCount = activeFilterCount(applyFilters, rules.length);

  const requestJoin = (game: Game) => {
    if (game.passwordProtected) {
      setPassword("");
      setPasswordGame(game);
    } else void join(game.id);
  };

  // The same menu as everywhere else, with this tab's join, which asks for
  // the password first.
  const { openPlayerMenu, playerMenu } = usePlayerMenu({ joinGame: requestJoin });

  const selectGameView = (view: GameViewMode) => {
    ipc.send({
      kind: "Settings",
      command: {
        type: "patchBrowsing",
        payload: { patch: { customGamesView: view } },
      },
    });
  };

  const updateGameBrowser = (changes: Partial<typeof gameBrowser>) => {
    ipc.send({
      kind: "Settings",
      command: {
        type: "patchBrowsing",
        payload: {
          patch: {
            customGamesBrowser: changes,
          },
        },
      },
    });
  };

  // With filters never remembered (#447), the next visit starts unfiltered.
  // The switches and rules only: the sort order is not a filter.
  useForgetFiltersOnLeave(() => {
    const defaults = DEFAULT_BROWSING_PREFERENCES.customGamesBrowser;
    updateGameBrowser({
      hidePrivate: defaults.hidePrivate,
      hideModded: defaults.hideModded,
      hideUnranked: defaults.hideUnranked,
      hideFoes: defaults.hideFoes,
      applyFilters: defaults.applyFilters,
      rules: defaults.rules,
    });
  });

  // The details panel's width, fold and stepping aside; a click on a game
  // picks it through `selectGame`, which can hold the panel back first.
  const detailLayout = useDetailPanelLayout({
    selected,
    join: lobby.join,
    gameView,
    gameBrowser,
    setSelectedId,
    updateGameBrowser,
  });

  const { hostOpen, coopMissionToHost, hostPrefill, openHostDialog, closeHostDialog } = useHostDialog();

  // How many people are in Galactic War, kept current for as long as the Play
  // tab is the tab being looked at.
  //
  // The mode strip prints that number, and it used to be whatever the gateway
  // said the last time somebody entered the Galactic War panel: an hour old,
  // or never fetched at all. "It says x players online, I open it and there is
  // nobody" is what that looks like from outside. Only the statistics are
  // asked for, not the install check, and only while this tab is mounted: the
  // gateway is a service outside FAF and this is not a background poller.
  useEffect(() => {
    const ask = () => ipc.send({ kind: "GalacticWar", command: { type: "refreshStatistics" } });
    ask();
    const timer = setInterval(ask, GALACTIC_WAR_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="play-view">
      {/* Join and launch progress now lives in the status bar beside the FAF
          and Chat indicators (`GameJoinStatus`), rather than as a banner that
          pushed the whole workspace down for one line of text. */}
      <PlayModeTabs
        mode={lobby.playMode}
        customGames={customGames.length}
        queuedPlayers={queuedPlayerCount(lobby.matchmakerQueues)}
        coopGames={coopGames.length}
        galacticWarOnline={onlineCommanders(galacticWar.statistics)}
        onChange={(mode) =>
          ipc.send({
            kind: "Lobby",
            command: { type: "setPlayMode", payload: { mode } },
          })
        }
      />

      {/* Each mode's panel carries the id its tab points at. On the panel's
          own outermost element, as `playModePanelProps` explains. */}
      {inMatchmaker ? (
        <MatchmakingPanel
          queues={lobby.matchmakerQueues}
          matchmaking={lobby.matchmaking}
          party={lobby.party}
          panelProps={playModePanelProps("matchmaking")}
        />
      ) : inCoop ? (
        <CoopPanel
          panelProps={playModePanelProps("coop")}
          games={filteredCoopGames}
          // The search box is this view's own state, which the panel cannot
          // reach: without this its Clear filters left the typed text in place.
          // No ranked filter here, as the co-op toolbar has none to show.
          onClearFilters={() => {
            setSearch("");
            updateGameBrowser({ hidePrivate: false, hideModded: false, hideFoes: false, applyFilters: false });
          }}
          viewMode={gameView}
          toolbar={(
            <CustomGamesToolbar
              search={search}
              sort={sort}
              viewMode={gameView}
              hidePrivate={hidePrivate}
              hideModded={hideModded}
              hideFoes={hideFoes}
              applyFilters={applyFilters}
              filterCount={filterCount}
              connected={connected}
              onSearch={setSearch}
              onSort={(value) => updateGameBrowser({ sort: value, sortReversed: false })}
              onViewMode={selectGameView}
              onHidePrivate={(value) => updateGameBrowser({ hidePrivate: value })}
              onHideModded={(value) => updateGameBrowser({ hideModded: value })}
              onHideFoes={(value) => updateGameBrowser({ hideFoes: value })}
              onApplyFilters={(value) => updateGameBrowser({ applyFilters: value })}
              onOpenFilters={() => setFiltersOpen(true)}
              onHost={() => openHostDialog()}
              onRefresh={() => ipc.send({ kind: "Coop", command: { type: "refreshCatalog" } })}
            />
          )}
          onJoin={requestJoin}
          onHost={openHostDialog}
        />
      ) : inGalacticWar ? (
        <GalacticWarPanel panelProps={playModePanelProps("galacticWar")} />
      ) : (
        <CustomGamesPanel
          panelProps={playModePanelProps("custom")}
          layout={detailLayout}
          toolbar={(
            <CustomGamesToolbar
              search={search}
              sort={sort}
              viewMode={gameView}
              hidePrivate={hidePrivate}
              hideModded={hideModded}
              hideUnranked={hideUnranked}
              hideFoes={hideFoes}
              applyFilters={applyFilters}
              filterCount={filterCount}
              connected={connected}
              onSearch={setSearch}
              onSort={(value) => updateGameBrowser({ sort: value, sortReversed: false })}
              onViewMode={selectGameView}
              onHidePrivate={(value) => updateGameBrowser({ hidePrivate: value })}
              onHideModded={(value) => updateGameBrowser({ hideModded: value })}
              onHideUnranked={(value) => updateGameBrowser({ hideUnranked: value })}
              onHideFoes={(value) => updateGameBrowser({ hideFoes: value })}
              onApplyFilters={(value) => updateGameBrowser({ applyFilters: value })}
              onOpenFilters={() => setFiltersOpen(true)}
              onHost={() => openHostDialog()}
              detailHidden={!detailLayout.detailShown}
              onToggleDetails={detailLayout.toggleDetails}
            />
          )}
          games={filtered}
          totalGames={customGames.length}
          selected={selected}
          vault={maps.vault}
          viewMode={gameView}
          status={lobby.status}
          join={lobby.join}
          onJoin={requestJoin}
          onPreview={setPreviewGame}
          onOpenUserMenu={openPlayerMenu}
          onReconnect={() => ipc.send({ kind: "Lobby", command: { type: "connect" } })}
          onHost={() => openHostDialog()}
          onClearFilters={() => {
            setSearch("");
            updateGameBrowser({
              hidePrivate: false,
              hideModded: false,
              hideUnranked: false,
              hideFoes: false,
              applyFilters: false,
            });
          }}
        />
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
          allowRules={gameBrowser.allowRules}
          onAllowChange={(nextRules) => updateGameBrowser({ allowRules: nextRules })}
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
            void join(passwordGame.id, password);
            setPasswordGame(null);
          }}
        />
      )}

      {playerMenu}
      {previewGame && (
        <Modal className="game-preview-modal" onClose={() => setPreviewGame(null)}>
          <GamePreviewDialog
            game={previewGame}
            vault={maps.vault}
            onClose={() => setPreviewGame(null)}
            onJoin={() => {
              const target = previewGame;
              setPreviewGame(null);
              requestJoin(target);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
