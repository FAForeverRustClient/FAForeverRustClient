// Co-op: the campaign missions and their record boards.
//
// Mirrors the Java client's `CoopController`: pick a campaign, pick a mission
// within it, read the briefing, and see the fastest completions filtered by
// team size.
//
// The mission list comes from `/data/coopMission` and `/data/coopScenario`.
// It used to be guessed by filtering the *map vault* for names containing
// "coop", "campaign", "operation" or "mission", which both missed missions
// named none of those things and swept in ordinary maps that were.

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { EmptyState } from "../../design-system/EmptyState";
import { ipc } from "../../ipc/client";
import type { CoopMission, CoopResult, CoopScenario, CoopStatus, Game } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { GameBrowserRow, GameTile, type GameViewMode } from "./CustomGamesBrowser";
import { coopFailureAction } from "./coopFailure";
import "./custom-games.css";
import { useTranslation } from "../../i18n/useTranslation";
import "./coop.css";

/** `0` means "any team size": matches `ANY_PLAYER_COUNT` in the domain. */
const PLAYER_COUNTS = [0, 1, 2, 3, 4];
const COOP_FACTION_ORDER: Record<CoopScenario["faction"], number> = {
  uef: 0,
  cybran: 1,
  aeon: 2,
  seraphim: 3,
  custom: 4,
};

const loadCatalog = () => ipc.send({ kind: "Coop", command: { type: "loadCatalog" } });
const selectMission = (missionId: number) =>
  ipc.send({ kind: "Coop", command: { type: "selectMission", payload: { missionId } } });
const setPlayerCount = (playerCount: number) =>
  ipc.send({ kind: "Coop", command: { type: "setPlayerCount", payload: { playerCount } } });

/** Seconds as `h:mm:ss` / `m:ss`: a mission time, not a duration in prose. */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function factionRank(faction: CoopScenario["faction"]): number {
  return COOP_FACTION_ORDER[faction] ?? COOP_FACTION_ORDER.custom;
}

/**
 * Stands for "the missions no campaign claims".
 *
 * The API expresses the link one way only (a campaign lists its maps), so
 * inverting it leaves missions with no owner. Filtering strictly by campaign
 * made those unreachable; this bucket is how their records can be read. It is
 * only offered when something is actually in it.
 */
const NO_CAMPAIGN = -1;

interface Props {
  games: Game[];
  viewMode?: GameViewMode;
  toolbar?: ReactNode;
  onJoin: (game: Game) => void;
  onHost: (mission?: CoopMission) => void;
}

export function CoopPanel({ games, viewMode = "tiles", toolbar, onJoin, onHost }: Props) {
  const { t } = useTranslation();
  const coop = useAppStore((state) => state.state.coop);
  const maps = useAppStore((state) => state.state.maps);
  const [selectedScenarioId, setSelectedScenarioId] = useState<number | null>(null);
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (useAppStore.getState().state.coop.catalogStatus.type === "idle") void loadCatalog();
  }, []);

  // Organize scenarios and missions
  const orphanCount = useMemo(
    () => coop.missions.filter((mission) => mission.scenarioId === null).length,
    [coop.missions],
  );

  const scenarios = useMemo(() => {
    return [...coop.scenarios].sort(
      (a, b) => factionRank(a.faction) - factionRank(b.faction) || a.order - b.order || a.name.localeCompare(b.name),
    );
  }, [coop.scenarios]);

  // Set default scenario when catalog loads
  useEffect(() => {
    if (selectedScenarioId === null && scenarios.length > 0) {
      setSelectedScenarioId(scenarios[0].id);
    }
  }, [scenarios, selectedScenarioId]);

  const activeScenarioId = selectedScenarioId ?? scenarios[0]?.id ?? null;

  const missionsInActiveScenario = useMemo(() => {
    return coop.missions
      .filter((mission) =>
        activeScenarioId === NO_CAMPAIGN
          ? mission.scenarioId === null
          : mission.scenarioId === activeScenarioId,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [coop.missions, activeScenarioId]);

  // Selected mission
  const selected = coop.missions.find((mission) => mission.id === coop.selectedMissionId) ?? missionsInActiveScenario[0] ?? null;

  // Auto-select first mission when scenario changes if current selection is not in scenario
  useEffect(() => {
    if (missionsInActiveScenario.length > 0) {
      const isCurrentInScenario = missionsInActiveScenario.some((m) => m.id === coop.selectedMissionId);
      if (!isCurrentInScenario) {
        void selectMission(missionsInActiveScenario[0].id);
      }
    }
  }, [missionsInActiveScenario, coop.selectedMissionId]);

  const connected = useAppStore((state) => state.state.lobby.status === "connected");

  const catalogNote = loadStatusNote(
    coop.catalogStatus,
    t("lobby.coop.loadingMissions"),
    t("lobby.coop.loadFailed"),
  );

  return (
    <div className="coop-panel">
      {coop.catalogStatus.type === "failed" ? (
        <CoopLoadFailure
          status={coop.catalogStatus}
          title={t("lobby.coop.loadFailed")}
          onRetry={() => void loadCatalog()}
        />
      ) : (
        catalogNote && <p className="muted">{catalogNote}</p>
      )}

      <div className="coop-layout">
        {toolbar}

        {/* Left Column (Priority #1): Open Co-op Games Browser */}
        <section className={`coop-games-main surface-panel game-browser-${viewMode}`}>
          {games.length === 0 ? (
            <EmptyState
              icon="users"
              title={t("lobby.coop.noOpenGames")}
              hint={t("lobby.coop.hostToPlay")}
              className="coop-games-empty"
            >
              <Button variant="primary" disabled={!connected} onClick={() => onHost(selected ?? undefined)}>
                <Icon name="plus" size={16} /> {t("lobby.toolbar.hostGame")}
              </Button>
            </EmptyState>
          ) : viewMode === "list" ? (
            <div className="game-browser-list">
              <div className="game-browser-head">
                <span>{t("lobby.browser.column.game")}</span>
                <span>{t("lobby.browser.column.map")}</span>
                <span>{t("lobby.browser.column.players")}</span>
                <span>{t("lobby.browser.column.rating")}</span>
                <span>{t("lobby.browser.column.age")}</span>
              </div>
              {games.map((game) => (
                <GameBrowserRow
                  key={game.id}
                  game={game}
                  vault={maps.vault}
                  selected={selectedGameId === game.id}
                  onSelect={() => setSelectedGameId(game.id)}
                  onJoin={() => onJoin(game)}
                />
              ))}
            </div>
          ) : (
            <div className="game-tile-grid">
              {games.map((game) => (
                <GameTile
                  key={game.id}
                  game={game}
                  vault={maps.vault}
                  selected={selectedGameId === game.id}
                  now={now}
                  onSelect={() => setSelectedGameId(game.id)}
                  onJoin={() => onJoin(game)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Right Column (Priority #2): Campaign & Mission Leaderboard */}
        <aside className="coop-detail surface-panel">
          <div className="coop-mission-picker">
            <div className="coop-picker-field">
              <label htmlFor="coop-scenario-select">{t("lobby.coop.campaign")}</label>
              <select
                id="coop-scenario-select"
                className="search-panel-control"
                value={activeScenarioId ?? ""}
                onChange={(event) => {
                  const id = Number(event.target.value);
                  setSelectedScenarioId(id);
                }}
              >
                {scenarios.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>
                    {scenario.name} ({scenario.faction.toUpperCase()})
                  </option>
                ))}
                {orphanCount > 0 && (
                  <option value={NO_CAMPAIGN}>{t("lobby.coop.withoutCampaign")}</option>
                )}
              </select>
            </div>

            <div className="coop-picker-field">
              <label htmlFor="coop-mission-select">{t("lobby.coop.mission")}</label>
              <select
                id="coop-mission-select"
                className="search-panel-control"
                value={selected?.id ?? ""}
                onChange={(event) => {
                  const id = Number(event.target.value);
                  void selectMission(id);
                }}
              >
                {missionsInActiveScenario.map((mission) => (
                  <option key={mission.id} value={mission.id}>
                    {mission.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {selected ? (
            <MissionDetail mission={selected} />
          ) : (
            <p className="muted">{t("lobby.coop.selectAbove")}</p>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The briefing and the record board.
 *
 * No art and no Host button any more: hosting is one dialog now, reached from
 * the toolbar, and the mission's preview belongs beside the campaign list in
 * there. What is left on this side is the leaderboard and the two selects that
 * choose whose leaderboard it is.
 */
function MissionDetail({ mission }: { mission: CoopMission }) {
  const { t } = useTranslation();
  const coop = useAppStore((state) => state.state.coop);
  const note = loadStatusNote(
    coop.leaderboardStatus,
    t("lobby.coop.loadingRecords"),
    t("lobby.coop.leaderboardFailed"),
  );

  return (
    <>
      {mission.description && <p className="coop-detail-brief">{mission.description}</p>}

      <div className="coop-board-head">
        <h4>{t("lobby.coop.fastest")}</h4>
        <div className="coop-board-filter">
          <span className="coop-board-filter-label">
            <Icon name="users" size={13} />
            <span>{t("lobby.coop.column.players")}:</span>
          </span>
          <div className="coop-player-count-group" role="group" aria-label={t("lobby.coop.teamSizeAria")}>
            {PLAYER_COUNTS.map((count) => {
              const label = count === 0 ? t("lobby.coop.anyCount") : String(count);
              const active = coop.playerCount === count;
              return (
                <button
                  key={count}
                  type="button"
                  className={active ? "is-active" : ""}
                  aria-pressed={active}
                  title={count === 0 ? t("lobby.coop.anyCount") : `${count} ${t("lobby.coop.column.players").toLowerCase()}`}
                  onClick={() => void setPlayerCount(count)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {coop.leaderboardStatus.type === "failed" ? (
        <CoopLoadFailure
          status={coop.leaderboardStatus}
          title={t("lobby.coop.recordsFailed")}
          onRetry={() => void setPlayerCount(coop.playerCount)}
        />
      ) : (
        note && <p className="muted">{note}</p>
      )}

      {coop.leaderboardStatus.type === "ready" && coop.leaderboard.length === 0 && (
        <p className="muted">
          {t("lobby.coop.noRecords")}
        </p>
      )}

      {coop.leaderboard.length > 0 && (
        <div className="coop-board-scroll">
          <table className="coop-board">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{t("lobby.coop.column.time")}</th>
                <th scope="col">{t("lobby.coop.column.players")}</th>
                <th scope="col">{t("lobby.coop.column.team")}</th>
                <th scope="col">{t("lobby.coop.column.secondary")}</th>
                <th scope="col">{t("lobby.coop.column.replay")}</th>
              </tr>
            </thead>
            <tbody>
              {coop.leaderboard.map((result) => (
                <LeaderboardRow key={result.id} result={result} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CoopLoadFailure({
  status,
  title,
  onRetry,
}: {
  status: CoopStatus;
  title: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (status.type !== "failed") return null;

  const { kind, reason } = status.payload;
  const action = coopFailureAction(kind);
  const signOut = () => ipc.send({ kind: "Auth", command: { type: "logout" } });

  return (
    <div className="surface-error coop-load-error" role="alert">
      <Icon name="activity" size={18} />
      <div>
        <strong>{title}</strong>
        <p>{reason}</p>
      </div>
      {action === "signOut" && (
        <Button onClick={() => void signOut()}>
          <Icon name="logout" size={14} /> {t("lobby.coop.signOut")}
        </Button>
      )}
      {action === "retry" && (
        <Button onClick={onRetry}>
          <Icon name="refresh" size={14} /> {t("lobby.coop.retry")}
        </Button>
      )}
    </div>
  );
}

function LeaderboardRow({ result }: { result: CoopResult }) {
  const { t } = useTranslation();
  return (
    <tr>
      <td>{result.ranking}</td>
      <td className="coop-board-time">{formatDuration(result.durationSeconds)}</td>
      <td>{result.playerCount}</td>
      <td className="coop-board-team" title={result.players.join(", ")}>
        {result.players.join(", ") || <span className="muted">{t("lobby.coop.unknownPlayers")}</span>}
      </td>
      {/* Completing the optional objectives is the harder run, so it is worth
          distinguishing rather than hiding in a tooltip. */}
      <td>{result.secondaryObjectives ? t("lobby.coop.yes") : "N/A"}</td>
      <td>
        {/* One click plays back exactly this run: `watchVault` downloads the
            replay the record was set with and starts the game on it, the same
            path the replay vault uses. */}
        {result.replayId === null ? (
          <span className="coop-board-no-replay">{t("lobby.coop.noReplay")}</span>
        ) : (
          <button
            type="button"
            className="coop-board-replay"
            title={t("lobby.coop.watchRunTitle")}
            onClick={() =>
              ipc.send({
                kind: "Replays",
                command: { type: "watchVault", payload: { uid: result.replayId as number } },
              })
            }
          >
            <Icon name="play" size={11} />
            {t("lobby.coop.watch")}
          </button>
        )}
      </td>
    </tr>
  );
}
