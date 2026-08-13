// Replays tab — three sub-views (mirrors the Java client's vault/replay.fxml
// ToggleButton row): Live (in-progress games), Online (global vault feed),
// Local (files in the shared FAF replay folder). Pure: selects state +
// dispatches commands, no logic of its own (same posture as CustomGamesView.tsx).
// The sub-view choice is presentation-only, so it's local component state,
// not routed through the backend Nav slice.

import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { LocalReplay, ReplayStatus, ReplayTeam, VaultReplay, VaultStatus } from "../../ipc/bindings";

type SubView = "live" | "online" | "local";

const WATCHED_STORAGE_KEY = "faf-watched-replay-uids";

function loadWatchedUids(): Set<number> {
  try {
    const raw = window.localStorage.getItem(WATCHED_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveWatchedUids(uids: Set<number>) {
  window.localStorage.setItem(WATCHED_STORAGE_KEY, JSON.stringify([...uids]));
}

const FACTION_NAMES: Record<number, string> = { 1: "UEF", 2: "Aeon", 3: "Cybran", 4: "Seraphim" };
const FACTION_COLORS: Record<number, string> = {
  1: "#2196f3",
  2: "#4caf50",
  3: "#f44336",
  4: "#ffc107",
};

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}min ${s.toString().padStart(2, "0")}s`;
}

type SortKey = "recent" | "duration" | "rating";

const SORTERS: Record<SortKey, (a: VaultReplay, b: VaultReplay) => number> = {
  recent: (a, b) => b.startTime.localeCompare(a.startTime),
  duration: (a, b) => (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1),
  rating: (a, b) => (b.averageRating ?? -Infinity) - (a.averageRating ?? -Infinity),
};

const watchLive = (uid: number, modName: string, map: string) =>
  ipc.dispatch({
    kind: "Replays",
    command: { type: "watchLive", payload: { uid, modName, map } },
  });

const openFile = (path: string) =>
  ipc.dispatch({ kind: "Replays", command: { type: "openFile", payload: { path } } });

const loadVault = () => ipc.dispatch({ kind: "Replays", command: { type: "loadVault" } });

const watchVault = (uid: number) =>
  ipc.dispatch({ kind: "Replays", command: { type: "watchVault", payload: { uid } } });

const loadLocal = () => ipc.dispatch({ kind: "Replays", command: { type: "loadLocal" } });

const connectLobby = () => ipc.dispatch({ kind: "Lobby", command: { type: "connect" } });

function statusNote(status: ReplayStatus): string | null {
  switch (status.type) {
    case "idle":
      return null;
    case "connecting":
      return "Connecting to the replay…";
    case "playing":
      return status.payload.uid ? `Watching replay ${status.payload.uid}` : "Playing replay";
    case "failed":
      return `Replay failed: ${status.payload.reason}`;
  }
}

function loadNote(status: VaultStatus, loadingLabel: string, failedPrefix: string): string | null {
  switch (status.type) {
    case "idle":
    case "ready":
      return null;
    case "loading":
      return loadingLabel;
    case "failed":
      return `${failedPrefix}: ${status.payload.reason}`;
  }
}

async function pickReplayFile() {
  const path = await open({
    multiple: false,
    filters: [{ name: "FAF Replay", extensions: ["fafreplay", "scfareplay"] }],
  });
  if (typeof path === "string") {
    openFile(path);
  }
}

function LiveView({ busy }: { busy: boolean }) {
  const liveGames = useAppStore((s) => s.state.lobby.liveGames);
  const lobbyStatus = useAppStore((s) => s.state.lobby.status);

  // The live-games feed only flows once the lobby websocket is connected —
  // don't rely on the Play tab having been opened first (same auto-connect
  // posture as CustomGamesView.tsx's own useEffect).
  useEffect(() => {
    if (useAppStore.getState().state.lobby.status === "disconnected") {
      connectLobby();
    }
  }, []);

  if (lobbyStatus !== "connected") {
    return <p className="muted">Connecting to the lobby…</p>;
  }

  return liveGames.length === 0 ? (
    <p className="muted">No games in progress right now.</p>
  ) : (
    <ul className="game-list">
      {liveGames.map((g) => (
        <li key={g.id} className="game-row">
          <span className="game-title">{g.title}</span>
          <span className="game-map muted">{g.map}</span>
          <span className="game-host muted">host: {g.host}</span>
          <span className="game-players">
            {g.players}/{g.maxPlayers}
          </span>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => watchLive(g.id, g.modName, g.map)}
          >
            Watch
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ReplayTeamList({ teams, compact }: { teams: ReplayTeam[]; compact: boolean }) {
  if (teams.length === 0) return null;
  return (
    <div className={compact ? "replay-card-teams" : "replay-detail-teams"}>
      {teams.map((t) => (
        <div key={t.team} className={compact ? "replay-card-team" : "replay-detail-team"}>
          {!compact && <p className="replay-detail-team-title">Team {t.team}</p>}
          {t.players.map((p) => (
            <div key={p.name} className="replay-player">
              <span style={{ color: p.faction ? FACTION_COLORS[p.faction] : undefined }}>
                {p.faction ? `${FACTION_NAMES[p.faction]} · ` : ""}
                {p.name}
              </span>
              {p.rating !== null && <span className="muted">{p.rating}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function playerCount(teams: ReplayTeam[]): number {
  return teams.reduce((sum, t) => sum + t.players.length, 0);
}

function ReplayStars({ replay }: { replay: VaultReplay }) {
  if (replay.reviewsCount == null || replay.reviewsCount === 0) return null;
  return (
    <span className="replay-stars">
      {"★".repeat(Math.round(replay.reviewsAverage ?? 0))} ({replay.reviewsCount})
    </span>
  );
}

// Mirrors the Java client's replay_card.fxml: a 2-column icon-less meta grid
// (date/players, mod/rating, duration) below the thumbnail.
function ReplayMetaGrid({ replay }: { replay: VaultReplay }) {
  return (
    <div className="replay-meta-grid muted">
      <span>{formatDate(replay.startTime)}</span>
      <span>{playerCount(replay.teams)} players</span>
      <span>{replay.modName}</span>
      <span>{replay.averageRating !== null ? `~${replay.averageRating}` : "—"}</span>
      <span>{replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : ""}</span>
    </div>
  );
}

function ReplayCard({
  replay,
  watched,
  onOpen,
}: {
  replay: VaultReplay;
  watched: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      className={watched ? "replay-card replay-card-watched" : "replay-card"}
      onClick={onOpen}
    >
      <div className="replay-card-left">
        {replay.mapThumbnailUrl ? (
          <img className="replay-card-thumb" src={replay.mapThumbnailUrl} alt={replay.map} />
        ) : (
          <div className="replay-card-thumb" />
        )}
        <ReplayStars replay={replay} />
        <ReplayMetaGrid replay={replay} />
      </div>
      <div className="replay-card-right">
        <div className="replay-card-header">
          <span className="replay-card-title">{replay.title || replay.map}</span>
          <span className="replay-card-submap muted">auf {replay.map}</span>
        </div>
        <ReplayTeamList teams={replay.teams} compact />
        <div className="replay-card-footer muted">
          {!replay.replayAvailable && <span>not uploaded yet · </span>}
          <span>#{replay.uid}</span>
        </div>
      </div>
    </button>
  );
}

function ReplayDetailPanel({
  replay,
  busy,
  onClose,
  onWatch,
}: {
  replay: VaultReplay;
  busy: boolean;
  onClose: () => void;
  onWatch: () => void;
}) {
  return (
    <Modal onClose={onClose}>
      <div className="replay-detail-head">
        {replay.mapThumbnailUrl ? (
          <img className="replay-detail-thumb" src={replay.mapThumbnailUrl} alt={replay.map} />
        ) : (
          <div className="replay-detail-thumb" />
        )}
        <div className="replay-detail-headtext">
          <h2>{replay.title || replay.map}</h2>
          <p className="muted">auf {replay.map}</p>
          <div className="replay-meta-grid muted">
            <span>{formatDate(replay.startTime)}</span>
            <span>{playerCount(replay.teams)} players</span>
            <span>{replay.modName}</span>
            <span>{replay.averageRating !== null ? `~${replay.averageRating} rating` : "—"}</span>
            <span>{replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : ""}</span>
            <span className="muted">#{replay.uid}</span>
          </div>
        </div>
        <Button
          variant="primary"
          disabled={busy || !replay.replayAvailable}
          onClick={onWatch}
          className="replay-detail-watch"
        >
          {replay.replayAvailable ? "Watch" : "Not uploaded yet"}
        </Button>
      </div>
      <h3 className="replay-detail-lineup-title">Lineup</h3>
      <ReplayTeamList teams={replay.teams} compact={false} />
      {replay.reviewsCount != null && replay.reviewsCount > 0 && (
        <p className="replay-stars">
          {"★".repeat(Math.round(replay.reviewsAverage ?? 0))} {replay.reviewsAverage?.toFixed(1)} (
          {replay.reviewsCount} reviews)
        </p>
      )}
    </Modal>
  );
}

function OnlineView({ busy }: { busy: boolean }) {
  const vault = useAppStore((s) => s.state.replays.vault);
  const vaultStatus = useAppStore((s) => s.state.replays.vaultStatus);
  const note = loadNote(vaultStatus, "Loading replays…", "Could not load vault");
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [openUid, setOpenUid] = useState<number | null>(null);
  const [watchedUids, setWatchedUids] = useState<Set<number>>(() => loadWatchedUids());

  useEffect(() => {
    if (useAppStore.getState().state.replays.vaultStatus.type === "idle") {
      loadVault();
    }
  }, []);

  const sorted = useMemo(() => [...vault].sort(SORTERS[sortKey]), [vault, sortKey]);
  const openReplay = vault.find((r) => r.uid === openUid) ?? null;

  const markWatchedAndPlay = (uid: number) => {
    const next = new Set(watchedUids).add(uid);
    setWatchedUids(next);
    saveWatchedUids(next);
    watchVault(uid);
  };

  return (
    <>
      <div className="replay-sort-row">
        <span className="muted">Sort by:</span>
        {(["recent", "duration", "rating"] as SortKey[]).map((key) => (
          <Button
            key={key}
            variant={sortKey === key ? "primary" : "ghost"}
            onClick={() => setSortKey(key)}
          >
            {key === "recent" ? "Date" : key === "duration" ? "Duration" : "Rating"}
          </Button>
        ))}
      </div>
      {note && <p className="muted">{note}</p>}
      {vaultStatus.type === "ready" && vault.length === 0 && (
        <p className="muted">No replays found.</p>
      )}
      {sorted.length > 0 && (
        <div className="replay-grid">
          {sorted.map((r) => (
            <ReplayCard
              key={r.uid}
              replay={r}
              watched={watchedUids.has(r.uid)}
              onOpen={() => setOpenUid(r.uid)}
            />
          ))}
        </div>
      )}
      {openReplay && (
        <ReplayDetailPanel
          replay={openReplay}
          busy={busy}
          onClose={() => setOpenUid(null)}
          onWatch={() => {
            markWatchedAndPlay(openReplay.uid);
            setOpenUid(null);
          }}
        />
      )}
    </>
  );
}

function LocalView({ busy }: { busy: boolean }) {
  const local = useAppStore((s) => s.state.replays.local);
  const localStatus = useAppStore((s) => s.state.replays.localStatus);
  const note = loadNote(localStatus, "Scanning local replays…", "Could not scan replay folder");

  useEffect(() => {
    if (useAppStore.getState().state.replays.localStatus.type === "idle") {
      loadLocal();
    }
  }, []);

  return (
    <>
      <div className="lobby-head">
        <span className="spacer" />
        <Button onClick={pickReplayFile} disabled={busy}>
          Open replay file…
        </Button>
      </div>
      {note && <p className="muted">{note}</p>}
      {localStatus.type === "ready" && local.length === 0 && (
        <p className="muted">No local replays found.</p>
      )}
      {local.length > 0 && (
        <ul className="game-list">
          {local.map((r: LocalReplay) => (
            <li key={r.path} className="game-row">
              <span className="game-title">{r.title || r.map}</span>
              <span className="game-map muted">{r.map}</span>
              <span className="game-host muted">{r.modName}</span>
              <Button variant="primary" disabled={busy} onClick={() => openFile(r.path)}>
                Watch
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const SUB_VIEWS: Record<SubView, { label: string; Component: (p: { busy: boolean }) => JSX.Element }> = {
  live: { label: "Live", Component: LiveView },
  online: { label: "Online", Component: OnlineView },
  local: { label: "Local", Component: LocalView },
};

export function ReplaysView() {
  const [subView, setSubView] = useState<SubView>("online");
  const status = useAppStore((s) => s.state.replays.status);
  const lastWarning = useAppStore((s) => s.state.replays.lastWarning);
  const note = statusNote(status);
  const busy = status.type === "connecting";
  const { Component } = SUB_VIEWS[subView];

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h2>Replays</h2>
        {note && <span className="join-note muted">{note}</span>}
      </div>

      {status.type === "playing" && lastWarning && (
        <p className="replay-warning">
          Launched, but: {lastWarning} — FA may get stuck loading if this doesn't resolve itself.
        </p>
      )}

      <div className="lobby-head">
        {(Object.keys(SUB_VIEWS) as SubView[]).map((key) => (
          <Button
            key={key}
            variant={subView === key ? "primary" : "ghost"}
            onClick={() => setSubView(key)}
          >
            {SUB_VIEWS[key].label}
          </Button>
        ))}
      </div>

      <Component busy={busy} />
    </div>
  );
}
