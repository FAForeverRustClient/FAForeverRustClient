import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pagination } from "../../../design-system/Pagination";
import { StatusNotice } from "../../../design-system/StatusNotice";
import type { ReplayQuery } from "../../../ipc/bindings";
import { ipc } from "../../../ipc/client";
import { useAppStore } from "../../../store/store";
import { isSeedlessGeneratedMap, isUnknownVaultMap } from "../../../shared/mapPresentation";
import { isoDaysAgo, personalReplayQuery } from "../../../shared/replayQuery";
import { loadStoredSet, saveStoredSet } from "../../../shared/storage";
import { usePlayerMenu } from "../../../shared/hooks/usePlayerMenu";
import { OnlineReplayList } from "../OnlineReplayList";
import { ReplayCard } from "../ReplayCard";
import { ReplayDetailPanel } from "../ReplayDetailPanel";
import { ReplayViewSwitch, type ReplayViewMode } from "../ReplayViewSwitch";
import { subscribeReplaySearch, takeReplaySearch } from "../../../shared/replaySearchIntent";
import { VaultSearch } from "./VaultSearch";
import { ReplayPageSize } from "./AdvancedReplayFilters";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import "../online-replays.css";
import { useTranslation } from "../../../i18n/useTranslation";
import { plainError } from "../../../shared/plainError";
import {
  filterMemoryNow,
  isFilterRecord,
  rememberedFilter,
  useRememberFilter,
} from "../../../shared/filterMemory";

/** Where the vault's search is remembered (#447). */
const ONLINE_REPLAY_FILTERS = "replays.online";

/**
 * The selector's answer when nothing has been resolved yet. A literal `{}` in
 * the selector would be a new object on every render, which is a new value to
 * the store's identity check and a render loop.
 */
const NO_RESOLVED_MAPS: Record<number, string> = {};

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
  const { t } = useTranslation();
  // The same menu a nickname opens in chat and in the live tab. Held here
  // rather than in the card, because the card is rendered once per replay and
  // this hook reads five store slices.
  const { openPlayerMenu, playerMenu } = usePlayerMenu();
  const vault = useAppStore((s) => s.state.replays.vault);
  const vaultStatus = useAppStore((s) => s.state.replays.vaultStatus);
  const resolvedMaps = useAppStore((s) => s.state.replays.resolvedMaps ?? NO_RESOLVED_MAPS);
  const downloadStatus = useAppStore((s) => s.state.replays.downloadStatus);
  const query = useAppStore((s) => s.state.replays.vaultQuery);
  const hasMore = useAppStore((s) => s.state.replays.vaultHasMore);
  const featuredMods = useAppStore((s) => s.state.replays.featuredMods);
  const leaderboards = useAppStore((s) => s.state.leaderboard.ratingLeaderboards);
  const self = useAppStore((s) => s.state.auth.player?.name ?? "");
  // Names for the friends picker in the search bar. A plain array off the
  // state, which the store keeps sorted and replaces wholesale, so the
  // identity check upstream is enough and nothing needs memoising here.
  const friends = useAppStore((s) => s.state.social.friends);
  const browsing = useAppStore((s) => s.state.settings.browsing);
  const viewMode: ReplayViewMode = browsing.replaysView;
  const setViewMode = (mode: ReplayViewMode) => {
    void ipc.send({
      kind: "Settings",
      command: {
        type: "patchBrowsing",
        payload: { patch: { replaysView: mode } },
      },
    });
  };
  const [openUid, setOpenUid] = useState<number | null>(null);
  // The detail panel's "Game result" switch, for the whole page at once
  // (#454). Off by default, as there: a result is a spoiler until asked for.
  const [showResults, setShowResults] = useState(false);
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [watchedUids, setWatchedUids] = useState<Set<number>>(() =>
    loadStoredSet(WATCHED_STORAGE_KEY, (value): value is number => typeof value === "number"),
  );

  // The vault opens on your own replays, every time, which is what was asked
  // for: a trainer who looks up a dozen other people in one sitting should not
  // find the twelfth of them waiting the next time the tab is opened.
  //
  // `replayVaultPlayer` still remembers the last name searched, and is still
  // what the form shows while a search is running, but it no longer decides
  // where the tab lands. Signed out there is no "own", so it is the fallback.
  const initialPlayer = self || browsing.replayVaultPlayer;

  // Somebody else's search wins over the default one, and having run it, the
  // default must not fire behind it: the store has not caught up yet, so
  // `vaultStatus` still reads `idle` for a beat. The ref is that beat.
  const handedOver = useRef(false);

  // One re-run per visit to the tab (issue 363). The effect below also fires
  // when the remembered vault player changes, which is a thing `handleSearch`
  // does on its way to running the reader's own search: without this the
  // re-run would land on top of it with the query it is replacing.
  const refreshed = useRef(false);

  const runRequestedSearch = useCallback(() => {
    const requested = takeReplaySearch();
    if (!requested) return false;
    handedOver.current = true;
    searchVault(requested);
    return true;
  }, []);

  useEffect(() => {
    const state = useAppStore.getState().state;
    const playerToSearch = self || state.settings.browsing.replayVaultPlayer;
    const memory = filterMemoryNow();
    if (!runRequestedSearch() && !handedOver.current) {
      const status = state.replays.vaultStatus.type;
      // The search left before a restart, when the filter setting keeps
      // filters that long (#447). Otherwise the landing search below.
      const kept = status === "idle" && memory === "restart"
        ? rememberedFilter<ReplayQuery | null>(ONLINE_REPLAY_FILTERS, null, isFilterRecord)
        : null;
      if (kept) {
        refreshed.current = true;
        searchVault(kept);
      } else if (status === "idle") {
        if (playerToSearch) {
          // The landing search is this visit's fresh one, so it counts as the
          // re-run. Unarmed, the first search of a session (the vault player
          // was not remembered yet, so it changes) re-ran the landing query
          // over the reader's own: "Skip short replays" did nothing on the
          // first press and switched itself back off.
          refreshed.current = true;
          searchVault(personalReplayQuery(playerToSearch, isoDaysAgo(365)));
        }
      } else if (status !== "loading" && !refreshed.current) {
        refreshed.current = true;
        // Every later visit runs the search that is on screen again, rather
        // than showing whatever the vault answered the last time the tab was
        // open (issue 363). Only the active tab is mounted, so this is once
        // per visit; the game you just finished is the row that was missing,
        // and pressing Search by hand to see it is not something a reader
        // should have to know to do. A search already in flight is left to
        // finish, and a failed one gets another try on the way back in.
        //
        // With filters never remembered (#447) that is the landing search
        // instead, at the page length in effect, which is not a filter.
        searchVault(memory === "never" && playerToSearch
          ? { ...personalReplayQuery(playerToSearch, isoDaysAgo(365)), pageSize: state.replays.vaultQuery.pageSize }
          : state.replays.vaultQuery);
      }
    }
    // The two dropdowns' contents. Both are cheap and cached in state, so
    // this is a no-op on every visit after the first.
    if (state.replays.featuredMods.length === 0) loadFeaturedMods();
    loadLeaderboards();
  }, [self, browsing.replayVaultPlayer, runRequestedSearch]);

  // The search on screen, for the next visit or the next start (#447).
  useRememberFilter(ONLINE_REPLAY_FILTERS, query);

  // And for the request that arrives while this tab is already open.
  useEffect(() => subscribeReplaySearch(() => { runRequestedSearch(); }), [runRequestedSearch]);

  // The listing has no map for a co-op game, so the replay files are asked
  // instead: the first 64 KiB of each, which is the envelope and enough of the
  // stream to read the scenario the engine loaded. Once per game, because an
  // answer is remembered whether or not it found anything, and only for the
  // rows this page actually turned up. A generated map the listing names
  // without its seed is asked about too: the card cannot generate it without
  // the seed, which is why most of them showed no generate button.
  useEffect(() => {
    const unread = vault
      .filter((replay) =>
        (isUnknownVaultMap(replay.map) || (isSeedlessGeneratedMap(replay.map) && replay.replayAvailable))
        && !(replay.uid in resolvedMaps))
      .map((replay) => replay.uid);
    if (unread.length === 0) return;
    ipc.send({ kind: "Replays", command: { type: "resolveMaps", payload: { uids: unread } } });
  }, [resolvedMaps, vault]);

  const handleSearch = (newQuery: ReplayQuery) => {
    if (newQuery.player !== browsing.replayVaultPlayer) {
      void ipc.send({
        kind: "Settings",
        command: {
          type: "patchBrowsing",
          payload: { patch: { replayVaultPlayer: newQuery.player } },
        },
      });
    }
    // The page size is set on the results line, not in the form, so a search
    // from the form keeps the one in effect: clearing the filters is not a
    // request for a different page length.
    searchVault({ ...newQuery, pageSize: query.pageSize });
  };

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

  const setWatchedMark = (uid: number, marked: boolean) => {
    if (watchedUids.has(uid) === marked) return;
    const next = new Set(watchedUids);
    if (marked) next.add(uid);
    else next.delete(uid);
    setWatchedUids(next);
    saveStoredSet(WATCHED_STORAGE_KEY, next);
  };

  const markWatchedAndPlay = (uid: number) => {
    setWatchedMark(uid, true);
    watchVault(uid);
  };

  // Paging reads the *executed* query, so it can't be thrown off by edits
  // sitting unsubmitted in the form.
  const goToPage = (page: number) => searchVault({ ...query, page });
  // Passed straight through, `null` and all. The old fallback of
  // `Math.max(maxPage, query.page)` invented a page count from what had been
  // clicked so far, which is why the numbered buttons appeared one at a time as
  // you paged. When the API does not report a total, the control now says which
  // page you are on instead of guessing how many there are.
  const totalPages = useAppStore((s) => s.state.replays.vaultTotalPages);
  const totalRecords = useAppStore((s) => s.state.replays.vaultTotalRecords);

  const formInitialQuery: ReplayQuery = useMemo(() =>
    vaultStatus.type === "idle"
      ? personalReplayQuery(initialPlayer, isoDaysAgo(365))
      : query,
  [vaultStatus.type, initialPlayer, query]);

  return (
    <>
      <VaultSearch
        featuredMods={featuredMods}
        leaderboards={leaderboards}
        self={self}
        friends={friends}
        initialQuery={formInitialQuery}
        onSearch={handleSearch}
      />
      <div className="online-replay-view-bar">
        <div className="online-replay-view-bar-left">
          {/* The server's own totals, not a count of what is on screen. Both
              reference clients show the size of the result set, and it is the
              only way to tell a genuinely small match from a pager that is
              misreading the page count. */}
          {/* `null` is the backend saying it does not know the total, which
              happens whenever a filter it cannot express made this a bounded
              scan. Printing the length of the current page as the total, which
              is what this used to do, turns that into a wrong number: "50
              shown, 50 found, 3 pages" contradicts itself, and the care taken
              on the other side to send no total at all was thrown away here. */}
          <span className="muted">
            {totalRecords === null
              ? t("replays.vault.resultCountUnknown", {
                  shown: vault.length,
                  pages: totalPages ?? 1,
                })
              : t("replays.vault.resultCount", {
                  shown: vault.length,
                  total: totalRecords,
                  pages: totalPages ?? 1,
                })}
          </span>
        </div>
        <div className="online-replay-view-bar-right">
          <Button
            className="replay-detail-reveal-btn"
            aria-pressed={showResults}
            onClick={() => setShowResults((visible) => !visible)}
          >
            <Icon name="eye" size={13} />
            <span>{t(showResults ? "replays.detail.hideResults" : "replays.detail.gameResult")}</span>
          </Button>
          {/* Applies at once, to the search on screen, from its first page. */}
          <ReplayPageSize
            value={query.pageSize}
            onChange={(pageSize) => searchVault({ ...query, pageSize, page: 1 })}
          />
          <ReplayViewSwitch value={viewMode} onChange={setViewMode} />
        </div>
      </div>
      {/* A failed search as a line of its own with the way to run it again.
          It was a muted fragment after "0 shown · 1 pages", which read as an
          empty result rather than a failure. */}
      {vaultStatus.type === "failed" && (
        <StatusNotice
          tone="error"
          action={{ label: t("common.retry"), onClick: () => searchVault(query) }}
          detail={vaultStatus.payload.reason}
        >
          {t("replays.vault.loadFailed")}: {plainError(vaultStatus.payload.reason)}
        </StatusNotice>
      )}
      {vaultStatus.type === "ready" && vault.length === 0 && (
        /* Past the end is not the same as no matches. Landing on an empty page
           after paging forward means the search worked and this page is beyond
           its results, which is what a full last page cannot distinguish. */
        <p className="muted">
          {t(query.page > 1 ? "replays.vault.pastEnd" : "replays.vault.noMatch")}
        </p>
      )}
      {vault.length > 0 && viewMode === "tiles" && (
        <div className="replay-grid">
          {vault.map((r) => (
            <ReplayCard
              key={r.uid}
              replay={r}
              watched={watchedUids.has(r.uid)}
              busy={busy}
              showResults={showResults}
              onOpen={() => setOpenUid(r.uid)}
              onDoubleClick={() => r.replayAvailable && !busy && markWatchedAndPlay(r.uid)}
              onWatch={() => {
                setSelectedUid(r.uid);
                if (!busy) markWatchedAndPlay(r.uid);
              }}
              onPlayerMenu={openPlayerMenu}
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
          showResults={showResults}
          onOpen={(uid) => {
            setSelectedUid(uid);
            setOpenUid(uid);
          }}
          onWatch={(uid) => {
            setSelectedUid(uid);
            if (!busy) markWatchedAndPlay(uid);
          }}
          onDownload={(uid) => {
            setSelectedUid(uid);
            downloadVault(uid);
          }}
          onToggleWatched={(uid) => setWatchedMark(uid, !watchedUids.has(uid))}
        />
      )}
      <div className="vault-pagination">
        <Pagination
          currentPage={query.page}
          totalPages={totalPages}
          hasMore={hasMore}
          onPageChange={goToPage}
          ariaLabel={t("replays.vault.pagesAria")}
        />
      </div>
      {openReplay && (
        <ReplayDetailPanel
          replay={openReplay}
          busy={busy}
          watched={watchedUids.has(openReplay.uid)}
          onToggleWatched={() => setWatchedMark(openReplay.uid, !watchedUids.has(openReplay.uid))}
          onClose={() => setOpenUid(null)}
          onDownload={() => downloadVault(openReplay.uid)}
          downloadState={openDownloadState}
          downloadError={openDownloadError}
          onWatch={() => {
            markWatchedAndPlay(openReplay.uid);
            setOpenUid(null);
          }}
          onPlayerMenu={openPlayerMenu}
        />
      )}
      {playerMenu}
    </>
  );
}
