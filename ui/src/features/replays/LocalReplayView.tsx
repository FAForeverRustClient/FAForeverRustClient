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
import {
  ReplayLibraryCard,
  ReplayDetailPanel,
  localReplayToVaultReplay,
  type ReplayCardData,
} from "./OnlineReplayPresentation";
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
import { t, type MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const PAGE_SIZE = 36;
const LOCAL_WATCHED_STORAGE_KEY = "faf-watched-local-replays";

function localReplayKey(replay: LocalReplay): string {
  return replay.uid === null ? replay.path : `uid:${replay.uid}`;
}

const openFile = (path: string) =>
  ipc.send({ kind: "Replays", command: { type: "openFile", payload: { path } } });
/// How many of the newest replays have their headers read. Ten pages, the
/// same default the backend uses; paging past it asks for more rather than
/// making every session wait for an archive of thousands.
const INITIAL_DETAIL_LIMIT = PAGE_SIZE * 10;
const loadLocal = (limit: number = INITIAL_DETAIL_LIMIT) =>
  ipc.send({ kind: "Replays", command: { type: "loadLocal", payload: { limit } } });
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

const LOCAL_STATUS_LABELS: Record<LocalReplay["status"], MessageKey> = {
  complete: "replays.local.status.complete",
  unread: "replays.local.status.unread",
  incomplete: "replays.local.status.incomplete",
  legacy: "replays.local.status.legacy",
  broken: "replays.local.status.broken",
};

function localStatusLabel(status: LocalReplay["status"]): string {
  return t(LOCAL_STATUS_LABELS[status]);
}

function localStatusTone(status: LocalReplay["status"]): "ok" | "warn" | "error" | "muted" {
  switch (status) {
    case "complete": return "ok";
    case "broken": return "error";
    case "incomplete":
    case "legacy":
      return "warn";
    // Not a problem with the file: its header simply has not been read yet.
    case "unread":
      return "muted";
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
    idLabel: replay.uid === null ? t("replays.local.noReplayId") : `#${replay.uid}`,
    title: replay.title || replay.fileName,
    map: presentation?.displayName || replay.map || t("replays.local.mapUnavailable"),
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
  const { t } = useTranslation();
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
  const [openReplay, setOpenReplay] = useState<LocalReplay | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LocalReplay | null>(null);
  const note = loadStatusNote(localStatus, t("replays.local.scanning"), t("replays.local.scanFailed"));

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

  // Paging into the part of the archive whose headers were never read: ask for
  // enough to cover it, plus the same run again so the next few pages are
  // already there.
  const [detailLimit, setDetailLimit] = useState(INITIAL_DETAIL_LIMIT);

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

  // Reaching the end of what has been read asks for the next run.
  //
  // Waiting until the user goes *past* the loaded set cannot work: the page
  // count is derived from the replays that are actually listed, so the last
  // loaded page is also the last page the pager offers, and there is no button
  // to press to get any further. That deadlock is why the tab stopped at page
  // 10 of an archive holding three thousand files. Triggering on arrival at the
  // last page instead, while the folder still holds more, keeps it moving.
  const moreOnDisk = detailLimit < local.length;
  useEffect(() => {
    if (!moreOnDisk || currentPage < totalPages) return;
    const next = detailLimit + INITIAL_DETAIL_LIMIT;
    setDetailLimit(next);
    loadLocal(next);
  }, [currentPage, detailLimit, moreOnDisk, totalPages]);

  const featuredMods = useMemo(
    () => [...new Set(local.map((replay) => replay.modName).filter(Boolean))].sort(),
    [local],
  );

  const grouped = useMemo(() => {
    if (query.sortBy !== "date") return [{ label: t("replays.list.results"), replays: pageReplays }];
    const groups: Array<{ label: string; replays: LocalReplay[] }> = [];
    for (const replay of pageReplays) {
      const label = formatShortDate(localReplayTimestamp(replay), t("replays.list.unknownDate"));
      const current = groups[groups.length - 1];
      if (current?.label === label) current.replays.push(replay);
      else groups.push({ label, replays: [replay] });
    }
    return groups;
  }, [pageReplays, query.sortBy, t]);

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
        initialQuery={query.player === self ? { ...query, player: "" } : query}
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
          <span className="muted">{t("replays.local.countOfTotal", {
            shown: filtered.length,
            total: local.length,
            count: local.length,
          })}</span>
          {note && <span className="online-replay-status-note muted">· {note}</span>}
        </div>
        <ReplayViewSwitch value={viewMode} onChange={setViewMode} />
      </div>
      {localStatus.type === "ready" && filtered.length === 0 ? (
        <div className="live-replay-empty surface-panel">
          <Icon name={local.length === 0 ? "replays" : "search"} size={22} />
          <h3>{t(local.length === 0 ? "replays.local.noneFound" : "replays.local.noneMatch")}</h3>
          <p>{t(local.length === 0 ? "replays.local.noneFoundHint" : "replays.local.noneMatchHint")}</p>
        </div>
      ) : pageReplays.length > 0 && viewMode === "tiles" ? (
        <>
          <div className="replay-grid">
            {pageReplays.map((replay) => (
              <ReplayLibraryCard
                key={replay.path}
                replay={localReplayCard(replay, mapVault)}
                watched={watched.has(localReplayKey(replay))}
                selected={openReplay?.path === replay.path}
                onOpen={() => setOpenReplay(replay)}
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
                ariaLabel={t("replays.local.pagesAria")}
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
                  replay.recorder || t("replays.local.noRecorder"),
                  formatFileSize(replay.fileSizeBytes),
                  replay.uid === null ? t("replays.local.noReplayId") : `#${replay.uid}`,
                ].join(" · ");
                const simModLabel = replay.simMods.length === 0
                  ? t("replays.local.noSimMods")
                  : t("replays.local.simModCount", { count: replay.simMods.length });
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
                    secondary: t("replays.local.notRecorded"),
                  },
                  replay: {
                    primary: localStatusLabel(replay.status),
                    secondary: replayDetails,
                    tone: localStatusTone(replay.status),
                  },
                  selected: openReplay?.path === replay.path,
                  watched: watched.has(localReplayKey(replay)),
                  onSelect: () => setOpenReplay(replay),
                  onActivate: replay.watchable && !busy ? () => markWatchedAndOpen(replay) : undefined,
                  iconAction: {
                    icon: "close",
                    ariaLabel: t("replays.local.deleteAria", { name: replay.title || replay.fileName }),
                    title: t("replays.local.delete"),
                    onClick: () => setPendingDelete(replay),
                  },
                };
              }),
            }))}
            footer={<><span>{t("replays.local.footerCount", { shown: pageReplays.length, total: filtered.length })}</span><span>{t("replays.local.doubleClickHint")}</span></>}
          />
          {totalPages > 1 && (
            <div className="vault-pagination">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setPage}
                ariaLabel={t("replays.local.pagesAria")}
              />
            </div>
          )}
        </>
      )}
      {openReplay && (
        <ReplayDetailPanel
          replay={localReplayToVaultReplay(openReplay, mapVault)}
          busy={busy}
          localPath={openReplay.path}
          downloadState="downloaded"
          onClose={() => setOpenReplay(null)}
          onWatch={() => {
            markWatchedAndOpen(openReplay);
            setOpenReplay(null);
          }}
        />
      )}
      {pendingDelete && (
        <Modal onClose={() => setPendingDelete(null)}>
          <div className="local-delete-dialog">
            <h2>{t("replays.local.confirmDelete")}</h2>
            <p>{t("replays.local.confirmDeleteBody", { name: pendingDelete.title || pendingDelete.fileName })}</p>
            <div>
              <Button onClick={() => setPendingDelete(null)}>{t("replays.local.cancel")}</Button>
              <Button className="local-delete-confirm" onClick={() => { deleteLocal(pendingDelete.path); setPendingDelete(null); }}>{t("replays.local.delete")}</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
