import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { Pagination } from "../../design-system/Pagination";
import type { LocalReplay, ReplayTeam, VaultMap } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { loadStoredSet, saveStoredSet } from "../../shared/storage";
import { mapPresentation } from "../../shared/mapPresentation";
import { formatShortDate } from "../../shared/dates";
import { LocalReplaySearch } from "./LocalReplaySearch";
import { ReplayLibraryCard, type ReplayCardData } from "./OnlineReplayPresentation";
import { ReplayViewSwitch, type ReplayViewMode } from "./ReplayViewSwitch";
import {
  formatReplayListAge,
  formatReplayListTime,
  ReplayList,
  type ReplayListGroup,
} from "./ReplayList";
import {
  filterLocalReplays,
  localReplayTimestamp,
  personalLocalReplayQuery,
  type LocalReplayQuery,
} from "./localReplayQuery";
import "./local-replays.css";
import "./online-replays.css";

const PAGE_SIZE = 36;
const LOCAL_WATCHED_STORAGE_KEY = "faf-watched-local-replays";

function localReplayKey(replay: LocalReplay): string {
  return replay.uid === null ? replay.path : `uid:${replay.uid}`;
}

const openFile = (path: string) =>
  ipc.send({ kind: "Replays", command: { type: "openFile", payload: { path } } });
const loadLocal = () => ipc.send({ kind: "Replays", command: { type: "loadLocal" } });
const deleteLocal = (path: string) =>
  ipc.send({ kind: "Replays", command: { type: "deleteLocal", payload: { path } } });

function pickReplayFile(): void {
  ipc.run(native.selectFile({
    filters: [{ name: "FAF Replay", extensions: ["fafreplay", "scfareplay"] }],
  }).then((path) => {
    if (path) openFile(path);
  }));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function localStatusLabel(status: LocalReplay["status"]): string {
  switch (status) {
    case "complete": return "Complete";
    case "incomplete": return "Incomplete metadata";
    case "legacy": return "Legacy replay";
    case "broken": return "Parse error";
  }
}

function localStatusTone(status: LocalReplay["status"]): "ok" | "warn" | "error" {
  switch (status) {
    case "complete": return "ok";
    case "broken": return "error";
    case "incomplete":
    case "legacy":
      return "warn";
  }
}

function localReplayTeams(replay: LocalReplay): ReplayTeam[] {
  return replay.teams.map((team) => ({
    team: team.team === "null" ? -1 : Number.parseInt(team.team, 10) || 0,
    players: team.players.map((player) => ({
      name: player.name,
      faction: player.faction,
      rating: player.rating,
      outcome: "",
      score: null,
    })),
  }));
}

function localReplayCard(replay: LocalReplay, vault: VaultMap[]): ReplayCardData {
  const presentation = replay.map ? mapPresentation(vault, replay.map) : null;
  const timestamp = localReplayTimestamp(replay);
  return {
    idLabel: replay.uid === null ? "Replay ID N/A" : `#${replay.uid}`,
    title: replay.title || replay.fileName,
    map: presentation?.displayName || replay.map || "Map unavailable",
    mapThumbnailUrl: presentation?.thumbnailUrl || "",
    modName: replay.modName || "faf",
    startTime: timestamp > 0 ? new Date(timestamp).toISOString() : "",
    teams: localReplayTeams(replay),
    averageRating: replay.averageRating,
    gameDurationSeconds: null,
    durationSeconds: null,
    reviewsAverage: null,
    reviewsCount: null,
    footerNote: localStatusLabel(replay.status),
  };
}

export function LocalReplayView({ busy }: { busy: boolean }) {
  const local = useAppStore((s) => s.state.replays.local);
  const localStatus = useAppStore((s) => s.state.replays.localStatus);
  const mapVault = useAppStore((s) => s.state.maps.vault);
  const self = useAppStore((s) => s.state.auth.player?.name ?? "");
  const browsing = useAppStore((s) => s.state.settings.browsing);
  const viewMode: ReplayViewMode = browsing.replaysView;
  const setViewMode = (mode: ReplayViewMode) => {
    void ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: { preferences: { ...browsing, replaysView: mode } },
      },
    });
  };
  const [query, setQuery] = useState<LocalReplayQuery>(() => personalLocalReplayQuery(self));
  const [page, setPage] = useState(1);
  const [watched, setWatched] = useState<Set<string>>(() =>
    loadStoredSet(LOCAL_WATCHED_STORAGE_KEY, (value): value is string => typeof value === "string"),
  );
  const [pendingDelete, setPendingDelete] = useState<LocalReplay | null>(null);
  const note = loadStatusNote(localStatus, "Scanning local replays…", "Could not update replay library");

  useEffect(() => {
    if (useAppStore.getState().state.replays.localStatus.type === "idle") {
      loadLocal();
    }
    if (useAppStore.getState().state.maps.vaultStatus.type === "idle") {
      ipc.send({ kind: "Maps", command: { type: "loadVault" } });
    }
  }, []);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const filtered = useMemo(
    () => filterLocalReplays(
      local,
      query,
      (replay) => replay.map ? mapPresentation(mapVault, replay.map).displayName : "",
    ),
    [local, mapVault, query],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageReplays = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  );

  const featuredMods = useMemo(
    () => [...new Set(local.map((replay) => replay.modName).filter(Boolean))].sort(),
    [local],
  );

  const grouped = useMemo(() => {
    if (query.sortBy !== "date") return [{ label: "Results", replays: pageReplays }];
    const groups: Array<{ label: string; replays: LocalReplay[] }> = [];
    for (const replay of pageReplays) {
      const label = formatShortDate(localReplayTimestamp(replay), "Unknown date");
      const current = groups[groups.length - 1];
      if (current?.label === label) current.replays.push(replay);
      else groups.push({ label, replays: [replay] });
    }
    return groups;
  }, [pageReplays, query.sortBy]);

  const markWatchedAndOpen = (replay: LocalReplay) => {
    const key = localReplayKey(replay);
    if (!watched.has(key)) {
      const next = new Set(watched).add(key);
      setWatched(next);
      saveStoredSet(LOCAL_WATCHED_STORAGE_KEY, next);
    }
    openFile(replay.path);
  };

  return (
    <>
      <LocalReplaySearch
        initialQuery={query}
        self={self}
        featuredMods={featuredMods}
        loading={localStatus.type === "loading"}
        busy={busy}
        onSearch={setQuery}
        onRefresh={loadLocal}
        onOpenFile={pickReplayFile}
      />
      <div className="online-replay-view-bar">
        <div className="online-replay-view-bar-left">
          <span className="muted">{filtered.length} of {local.length} {local.length === 1 ? "replay" : "replays"}</span>
          {note && <span className="online-replay-status-note muted">· {note}</span>}
        </div>
        <ReplayViewSwitch value={viewMode} onChange={setViewMode} />
      </div>
      {localStatus.type === "ready" && filtered.length === 0 ? (
        <div className="live-replay-empty surface-panel">
          <Icon name={local.length === 0 ? "replays" : "search"} size={22} />
          <h3>{local.length === 0 ? "No local replays found" : "No local replays match"}</h3>
          <p>{local.length === 0 ? "Recorded and downloaded replay files will appear here." : "Adjust the search or status filter."}</p>
        </div>
      ) : pageReplays.length > 0 && viewMode === "tiles" ? (
        <>
          <div className="replay-grid">
            {pageReplays.map((replay) => (
              <ReplayLibraryCard
                key={replay.path}
                replay={localReplayCard(replay, mapVault)}
                watched={watched.has(localReplayKey(replay))}
                selected={false}
                onOpen={() => undefined}
                onDoubleClick={() => replay.watchable && !busy && markWatchedAndOpen(replay)}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="vault-pagination">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setPage}
                ariaLabel="Local replay pages"
              />
            </div>
          )}
        </>
      ) : pageReplays.length > 0 && (
        <>
          <ReplayList
            groups={grouped.map<ReplayListGroup>((group) => ({
              label: group.label,
              rows: group.replays.map((replay) => {
                const presentation = replay.map ? mapPresentation(mapVault, replay.map) : null;
                const replayTimestamp = localReplayTimestamp(replay);
                const mapName = presentation?.displayName || replay.map || replay.fileName;
                const replayDetails = [
                  replay.recorder || "Recorder N/A",
                  formatFileSize(replay.fileSizeBytes),
                  replay.uid === null ? "Replay ID N/A" : `#${replay.uid}`,
                ].join(" · ");
                const simModLabel = replay.simMods.length === 0
                  ? "No simulation mods"
                  : `${replay.simMods.length} simulation ${replay.simMods.length === 1 ? "mod" : "mods"}`;
                return {
                  key: replay.path,
                  mapName,
                  mapThumbnailUrl: presentation?.thumbnailUrl || "",
                  game: {
                    primary: replay.title || replay.fileName,
                    secondary: mapName,
                  },
                  played: {
                    primary: formatReplayListTime(replayTimestamp),
                    secondary: formatReplayListAge(replayTimestamp),
                  },
                  players: { primary: replay.numPlayers > 0 ? String(replay.numPlayers) : "N/A" },
                  rating: { primary: replay.averageRating === null ? "N/A" : String(replay.averageRating) },
                  mod: {
                    primary: replay.modName || "faf",
                    secondary: simModLabel,
                  },
                  duration: {
                    primary: "N/A",
                    secondary: "Not recorded locally",
                  },
                  replay: {
                    primary: localStatusLabel(replay.status),
                    secondary: replayDetails,
                    tone: localStatusTone(replay.status),
                  },
                  watched: watched.has(localReplayKey(replay)),
                  onActivate: replay.watchable && !busy ? () => markWatchedAndOpen(replay) : undefined,
                  iconAction: {
                    icon: "close",
                    ariaLabel: `Delete ${replay.title || replay.fileName}`,
                    title: "Delete replay",
                    onClick: () => setPendingDelete(replay),
                  },
                };
              }),
            }))}
            footer={<><span>Showing {pageReplays.length} of {filtered.length} replays</span><span>Double-click to watch</span></>}
          />
          {totalPages > 1 && (
            <div className="vault-pagination">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setPage}
                ariaLabel="Local replay pages"
              />
            </div>
          )}
        </>
      )}
      {pendingDelete && (
        <Modal onClose={() => setPendingDelete(null)}>
          <div className="local-delete-dialog">
            <h2>Delete local replay?</h2>
            <p>“{pendingDelete.title || pendingDelete.fileName}” will be permanently removed from the shared FAF replay folder.</p>
            <div>
              <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
              <Button className="local-delete-confirm" onClick={() => { deleteLocal(pendingDelete.path); setPendingDelete(null); }}>Delete replay</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
