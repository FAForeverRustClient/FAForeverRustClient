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

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import type { CoopMission, CoopResult, CoopScenario, CoopStatus, Game, VaultMap } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { mapThumbnailCandidates } from "../../shared/mapPresentation";
import { coopFailureAction } from "./coopFailure";
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

function secureImageUrl(url: string): string {
  return url.trim().replace(/^http:\/\//i, "https://");
}

function coopPreviewCandidates(mission: CoopMission, vault: VaultMap[]): string[] {
  return [...new Set([
    ...mapThumbnailCandidates(vault, mission.mapFolderName, true),
    mission.thumbnailUrlLarge,
    mission.thumbnailUrlSmall,
    ...mapThumbnailCandidates(vault, mission.mapFolderName),
  ].map(secureImageUrl).filter(Boolean))];
}

function CoopMissionPreview({ mission, vault }: { mission: CoopMission; vault: VaultMap[] }) {
  const candidates = useMemo(
    () => coopPreviewCandidates(mission, vault),
    [mission, vault],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => setCandidateIndex(0), [candidates]);

  const url = candidates[candidateIndex];
  if (!url) {
    return (
      <div className="coop-detail-art-placeholder" role="img" aria-label={`${mission.name} preview unavailable`}>
        <Icon name="maps" size={28} />
      </div>
    );
  }

  return (
    <img
      className="coop-detail-art"
      src={url}
      alt={`${mission.name} preview`}
      loading="lazy"
      decoding="async"
      onError={() => setCandidateIndex((index) => index + 1)}
    />
  );
}

interface Props {
  games: Game[];
  onJoin: (game: Game) => void;
  onHost: (mission: CoopMission) => void;
}

export function CoopPanel({ games, onJoin, onHost }: Props) {
  const coop = useAppStore((state) => state.state.coop);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (useAppStore.getState().state.coop.catalogStatus.type === "idle") void loadCatalog();
  }, []);

  const selected = coop.missions.find((mission) => mission.id === coop.selectedMissionId) ?? null;

  // Group missions under their campaign, putting the four faction campaigns
  // first in the same order as the faction picker. Within each faction, keep
  // the API order and sort missions by name: it carries the mission number in
  // practice ("Operation Ivory Sun 3"), so it is the campaign order.
  const groups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = (mission: CoopMission) =>
      !query || mission.name.toLocaleLowerCase().includes(query);

    const byScenario = [...coop.scenarios]
      .sort((a, b) => factionRank(a.faction) - factionRank(b.faction) || a.order - b.order || a.name.localeCompare(b.name))
      .map((scenario) => ({
        scenario,
        missions: coop.missions
          .filter((mission) => mission.scenarioId === scenario.id)
          .filter(matches)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((group) => group.missions.length > 0);

    // Missions the API did not place in any campaign still have to be
    // playable, so they get their own group rather than disappearing.
    const ungrouped = coop.missions
      .filter((mission) => mission.scenarioId === null)
      .filter(matches)
      .sort((a, b) => a.name.localeCompare(b.name));

    return ungrouped.length > 0
      ? [...byScenario, { scenario: null, missions: ungrouped }]
      : byScenario;
  }, [coop.missions, coop.scenarios, search]);

  const missionCount = groups.reduce((total, group) => total + group.missions.length, 0);
  const catalogNote = loadStatusNote(
    coop.catalogStatus,
    "Loading co-op missions…",
    "Could not load co-op missions",
  );

  return (
    <div className="coop-panel">
      <section className="coop-intro surface-panel">
        <div className="coop-intro-icon">
          <Icon name="users" size={22} />
        </div>
        <div>
          <h2>Co-op missions</h2>
          <p>
            Play the campaign together. Pick a mission to host it, and see how fast everyone else
            has finished it.
          </p>
        </div>
      </section>

      <div className="coop-toolbar">
        <div className="search-field">
          <Icon name="search" size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search missions"
            aria-label="Search co-op missions"
          />
        </div>
        <span className="muted">{missionCount} missions</span>
        <Button onClick={() => void loadCatalog()}>
          <Icon name="refresh" size={14} /> Refresh
        </Button>
      </div>

      {coop.catalogStatus.type === "failed" ? (
        <CoopLoadFailure
          status={coop.catalogStatus}
          title="Could not load co-op missions"
          onRetry={() => void loadCatalog()}
        />
      ) : (
        catalogNote && <p className="muted">{catalogNote}</p>
      )}

      {coop.catalogStatus.type === "ready" && missionCount === 0 && (
        <div className="play-empty-state">
          <Icon name="maps" size={24} />
          <h3>No co-op missions found</h3>
          <p>{search ? "Try another search." : "The mission catalog came back empty."}</p>
        </div>
      )}

      {missionCount > 0 && (
        <div className="coop-layout">
          <section className="coop-mission-panel surface-panel">
            <div className="section-heading">
              <div>
                <h3>Campaigns</h3>
                <span>Select a mission</span>
              </div>
            </div>
            <div className="coop-mission-list">
              {groups.map((group) => (
                <div className="coop-campaign" key={group.scenario?.id ?? "other"}>
                  <h4 className="coop-campaign-name">
                    {group.scenario?.name ?? "Other missions"}
                    {group.scenario && (
                      <span className={`coop-faction is-${group.scenario.faction}`}>
                        {group.scenario.faction}
                      </span>
                    )}
                  </h4>
                  {group.missions.map((mission) => (
                    <button
                      type="button"
                      key={mission.id}
                      className={
                        mission.id === coop.selectedMissionId
                          ? "surface surface-interactive coop-mission-row is-active"
                          : "surface surface-interactive coop-mission-row"
                      }
                      aria-current={mission.id === coop.selectedMissionId}
                      onClick={() => void selectMission(mission.id)}
                    >
                      {mission.name}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="coop-detail surface-panel">
            {selected ? (
              <MissionDetail mission={selected} onHost={onHost} />
            ) : (
              <p className="muted">Select a mission.</p>
            )}
          </section>

          <aside className="coop-games-panel surface-panel">
            <div className="section-heading">
              <div>
                <h3>Open co-op games</h3>
                <span>{games.length} available</span>
              </div>
            </div>
            {games.length === 0 ? (
              <div className="coop-games-empty">
                <Icon name="users" size={20} />
                <p>No open co-op games right now.</p>
                <small>Host a mission to start one.</small>
              </div>
            ) : (
              <div className="coop-games-list">
                {games.map((game) => (
                  <button className="coop-game-row" key={game.id} onClick={() => onJoin(game)}>
                    <span>
                      <strong>{game.title}</strong>
                      <small>
                        {game.host} · {game.map}
                      </small>
                    </span>
                    <b>
                      {game.players}/{game.maxPlayers}
                    </b>
                  </button>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function MissionDetail({
  mission,
  onHost,
}: {
  mission: CoopMission;
  onHost: (mission: CoopMission) => void;
}) {
  const coop = useAppStore((state) => state.state.coop);
  const maps = useAppStore((state) => state.state.maps);
  const note = loadStatusNote(
    coop.leaderboardStatus,
    "Loading records…",
    "Could not load the leaderboard",
  );

  return (
    <>
      <header className="coop-detail-head">
        <div>
          <h3>{mission.name}</h3>
          <small className="muted">{mission.mapFolderName}</small>
        </div>
        <Button variant="primary" onClick={() => onHost(mission)}>
          Host mission
        </Button>
      </header>

      <CoopMissionPreview mission={mission} vault={maps.vault} />

      {mission.description && <p className="coop-detail-brief">{mission.description}</p>}

      <div className="coop-board-head">
        <h4>Fastest completions</h4>
        <label className="coop-board-filter">
          <span className="muted">Players</span>
          <select
            value={coop.playerCount}
            onChange={(event) => void setPlayerCount(Number(event.target.value))}
            aria-label="Filter records by team size"
          >
            {PLAYER_COUNTS.map((count) => (
              <option key={count} value={count}>
                {count === 0 ? "Any" : count}
              </option>
            ))}
          </select>
        </label>
      </div>

      {coop.leaderboardStatus.type === "failed" ? (
        <CoopLoadFailure
          status={coop.leaderboardStatus}
          title="Could not load mission records"
          onRetry={() => void setPlayerCount(coop.playerCount)}
        />
      ) : (
        note && <p className="muted">{note}</p>
      )}

      {coop.leaderboardStatus.type === "ready" && coop.leaderboard.length === 0 && (
        <p className="muted">
          Nobody has finished this mission with that team size yet. Be the first.
        </p>
      )}

      {coop.leaderboard.length > 0 && (
        <div className="coop-board-scroll">
          <table className="coop-board">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Time</th>
                <th scope="col">Players</th>
                <th scope="col">Team</th>
                <th scope="col">Secondary</th>
                <th scope="col">Replay</th>
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
          <Icon name="logout" size={14} /> Sign out
        </Button>
      )}
      {action === "retry" && (
        <Button onClick={onRetry}>
          <Icon name="refresh" size={14} /> Retry
        </Button>
      )}
    </div>
  );
}

function LeaderboardRow({ result }: { result: CoopResult }) {
  return (
    <tr>
      <td>{result.ranking}</td>
      <td className="coop-board-time">{formatDuration(result.durationSeconds)}</td>
      <td>{result.playerCount}</td>
      <td>{result.players.join(", ") || <span className="muted">unknown</span>}</td>
      {/* Completing the optional objectives is the harder run, so it is worth
          distinguishing rather than hiding in a tooltip. */}
      <td>{result.secondaryObjectives ? "Yes" : "N/A"}</td>
      <td>
        {result.replayId === null ? (
          <span className="muted">, </span>
        ) : (
          <button
            type="button"
            className="coop-board-replay"
            onClick={() =>
              ipc.send({
                kind: "Replays",
                command: { type: "watchVault", payload: { uid: result.replayId as number } },
              })
            }
          >
            Watch
          </button>
        )}
      </td>
    </tr>
  );
}
