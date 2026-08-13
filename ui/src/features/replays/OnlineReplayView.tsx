import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import type { ReplayQuery } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { personalReplayQuery } from "../../shared/replayQuery";
import { loadStoredSet, saveStoredSet } from "../../shared/storage";
import { OnlineReplayList, ReplayCard, ReplayDetailPanel } from "./OnlineReplayPresentation";
import { ReplayViewSwitch, type ReplayViewMode } from "./ReplayViewSwitch";
import { VaultSearch } from "./VaultSearch";
import "./online-replays.css";

const WATCHED_STORAGE_KEY = "faf-watched-replay-uids";

const searchVault = (query: ReplayQuery) =>
  ipc.send({ kind: "Replays", command: { type: "searchVault", payload: { query } } });
const loadFeaturedMods = () =>
  ipc.send({ kind: "Replays", command: { type: "loadFeaturedMods" } });
const loadLeaderboards = () =>
  ipc.send({ kind: "Leaderboard", command: { type: "loadCatalog" } });
const watchVault = (uid: number) =>
  ipc.send({ kind: "Replays", command: { type: "watchVault", payload: { uid } } });
const downloadVault = (uid: number) =>
  ipc.send({ kind: "Replays", command: { type: "downloadVault", payload: { uid } } });

export function OnlineReplayView({ busy }: { busy: boolean }) {
  const vault = useAppStore((s) => s.state.replays.vault);
  const vaultStatus = useAppStore((s) => s.state.replays.vaultStatus);
  const downloadStatus = useAppStore((s) => s.state.replays.downloadStatus);
  const query = useAppStore((s) => s.state.replays.vaultQuery);
  const hasMore = useAppStore((s) => s.state.replays.vaultHasMore);
  const featuredMods = useAppStore((s) => s.state.replays.featuredMods);
  const leagues = useAppStore((s) => s.state.leaderboard.leagues);
  const self = useAppStore((s) => s.state.auth.player?.name ?? "");
  const note = loadStatusNote(vaultStatus, "Searching replays…", "Could not load vault");
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
  const [openUid, setOpenUid] = useState<number | null>(null);
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [watchedUids, setWatchedUids] = useState<Set<number>>(() =>
    loadStoredSet(WATCHED_STORAGE_KEY, (value): value is number => typeof value === "number"),
  );

  useEffect(() => {
    const state = useAppStore.getState().state;
    if (state.replays.vaultStatus.type === "idle") {
      searchVault(personalReplayQuery(self));
    }
    // The two dropdowns' contents. Both are cheap and cached in state, so
    // this is a no-op on every visit after the first.
    if (state.replays.featuredMods.length === 0) loadFeaturedMods();
    if (state.leaderboard.catalogStatus.type === "idle") loadLeaderboards();
  }, [self]);

  const openReplay = vault.find((r) => r.uid === openUid) ?? null;
  let openDownloadState: "idle" | "downloading" | "downloaded" | "failed" = "idle";
  let openDownloadError = "";
  if (
    openReplay
    && downloadStatus.type !== "idle"
    && downloadStatus.payload.uid === openReplay.uid
  ) {
    openDownloadState = downloadStatus.type;
    if (downloadStatus.type === "failed") openDownloadError = downloadStatus.payload.reason;
  }
  const loading = vaultStatus.type === "loading";

  const markWatchedAndPlay = (uid: number) => {
    const next = new Set(watchedUids).add(uid);
    setWatchedUids(next);
    saveStoredSet(WATCHED_STORAGE_KEY, next);
    watchVault(uid);
  };

  // Paging reads the *executed* query, so it can't be thrown off by edits
  // sitting unsubmitted in the form.
  const goToPage = (page: number) => searchVault({ ...query, page });

  return (
    <>
      <VaultSearch
        featuredMods={featuredMods}
        leagues={leagues}
        self={self}
        initialQuery={vaultStatus.type === "idle" ? personalReplayQuery(self) : query}
        onSearch={(q) => searchVault(q)}
      />
      <div className="online-replay-view-bar">
        <span className="muted">{vault.length} {vault.length === 1 ? "replay" : "replays"} on this page</span>
        <ReplayViewSwitch value={viewMode} onChange={setViewMode} />
      </div>
      {note && <p className="muted">{note}</p>}
      {vaultStatus.type === "ready" && vault.length === 0 && (
        <p className="muted">No replays match this search.</p>
      )}
      {vault.length > 0 && viewMode === "tiles" && (
        <div className="replay-grid">
          {vault.map((r) => (
            <ReplayCard
              key={r.uid}
              replay={r}
              watched={watchedUids.has(r.uid)}
              onOpen={() => setOpenUid(r.uid)}
              onDoubleClick={() => r.replayAvailable && !busy && markWatchedAndPlay(r.uid)}
            />
          ))}
        </div>
      )}
      {vault.length > 0 && viewMode === "list" && (
        <OnlineReplayList
          replays={vault}
          groupByDate={query.sortBy === "startTime" || query.sortBy === "endTime"}
          selectedUid={selectedUid}
          watchedUids={watchedUids}
          onSelect={setSelectedUid}
          onOpen={(uid) => {
            setSelectedUid(uid);
            setOpenUid(uid);
          }}
          onWatch={(uid) => {
            setSelectedUid(uid);
            if (!busy) markWatchedAndPlay(uid);
          }}
        />
      )}
      {(vault.length > 0 || query.page > 1) && (
        <div className="replay-pager">
          <Button disabled={query.page <= 1 || loading} onClick={() => goToPage(query.page - 1)}>
            Previous
          </Button>
          <span className="muted">Page {query.page}</span>
          <Button disabled={!hasMore || loading} onClick={() => goToPage(query.page + 1)}>
            Next
          </Button>
        </div>
      )}
      {openReplay && (
        <ReplayDetailPanel
          replay={openReplay}
          busy={busy}
          onClose={() => setOpenUid(null)}
          onDownload={() => downloadVault(openReplay.uid)}
          downloadState={openDownloadState}
          downloadError={openDownloadError}
          onWatch={() => {
            markWatchedAndPlay(openReplay.uid);
            setOpenUid(null);
          }}
        />
      )}
    </>
  );
}
