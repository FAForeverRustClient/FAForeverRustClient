// The selected event: the detail pane and every command it can send, wired
// to the event that is open. Each store field it reads is its own
// subscription, so a write to an unrelated part of the tab's slice does not
// redraw the largest tree in it.
//
// The commands go down as the groups in `tourneyActions`, built once per open
// event: a section that is memoised then keeps its props across the many
// redraws that are about something else (a chat poll, the tab's minute tick).

import { useMemo } from "react";
import type { TourneyMatch } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import { busyMatchId, openEvent } from "../../shared/rules/tourneyRules";
import { useAppStore } from "../../store/store";
import { TournamentDetailPane } from "./detail/TournamentDetailPane";
import type { MapImport } from "./manage/MapImportDialog";
import type { SitePage } from "./site/sitePages";
import { createTourneyActions } from "./tourneyActions";

interface Props {
  /** A section the pending bar asked the detail to open. */
  jump: { section: string; nonce: number } | null;
  onOpenPage: (page: SitePage) => void;
  /** Open the signup dialog for this event. */
  onSignUp: (tournamentId: string) => void;
  /** Open the score dialog for this match. */
  onReport: (entry: TourneyMatch) => void;
}

const openUrl = (url: string) => {
  void openHttpsUrl(url);
};

export function TournamentEventDetail({ jump, onOpenPage, onSignUp, onReport }: Props) {
  const { t } = useTranslation();
  const detail = useAppStore((store) => store.state.tourney.detail);
  const selectedId = useAppStore((store) => store.state.tourney.selectedId);
  const detailStatus = useAppStore((store) => store.state.tourney.detailStatus);
  const pending = useAppStore((store) => store.state.tourney.pending);
  const siteAdmin = useAppStore((store) => store.state.tourney.site.account.siteAdmin);
  const descImage = useAppStore((store) => store.state.tourney.descImage);
  const series = useAppStore((store) => store.state.tourney.series);
  const events = useAppStore((store) => store.state.tourney.events);
  const entrantProfiles = useAppStore((store) => store.state.tourney.entrantProfiles);
  const articles = useAppStore((store) => store.state.tourney.articles);
  const assetBase = useAppStore((store) => store.state.tourney.assetBase);
  const vault = useAppStore((store) => store.state.maps.vault);
  const vaultStatus = useAppStore((store) => store.state.maps.vaultStatus);
  const chatRooms = useAppStore((store) => store.state.tourney.chatRooms);
  const openRoomId = useAppStore((store) => store.state.tourney.openRoomId);
  const chatPosts = useAppStore((store) => store.state.tourney.chatPosts);
  const chatStatus = useAppStore((store) => store.state.tourney.chatStatus);
  const accountSearch = useAppStore((store) => store.state.tourney.accountSearch);
  const renames = useAppStore((store) => store.state.tourney.renames);
  const renamesStatus = useAppStore((store) => store.state.tourney.renamesStatus);
  const ratingCheck = useAppStore((store) => store.state.tourney.ratingCheck);
  const ratingCheckStatus = useAppStore((store) => store.state.tourney.ratingCheckStatus);
  const playerRatings = useAppStore((store) => store.state.tourney.playerRatings);
  const playerRatingsStatus = useAppStore((store) => store.state.tourney.playerRatingsStatus);
  const copySources = useAppStore((store) => store.state.tourney.copySources);
  const copySourcesStatus = useAppStore((store) => store.state.tourney.copySourcesStatus);
  const copySource = useAppStore((store) => store.state.tourney.copySource);
  const copySourceStatus = useAppStore((store) => store.state.tourney.copySourceStatus);
  const pinnedRoomId = useAppStore((store) => store.state.tourney.pinnedRoomId);
  const pinnedPosts = useAppStore((store) => store.state.tourney.pinnedPosts);

  // Never show one tournament's bracket under another's name: the pane waits
  // for the detail that belongs to the row that is open.
  const open = openEvent(detail, selectedId);
  const busy = pending !== null;
  // One match's spinner must not disable the rest of the bracket, so the
  // pending write is narrowed to the match it names, if it names one.
  const busyMatch = busyMatchId(pending);

  const tournamentId = open?.id ?? null;
  const actions = useMemo(
    () =>
      tournamentId === null
        ? null
        : createTourneyActions(tournamentId, { signUp: onSignUp, report: onReport }),
    [tournamentId, onSignUp, onReport],
  );
  const maps = actions?.maps;
  const mapImport = useMemo<MapImport | null>(
    () =>
      maps === undefined
        ? null
        : {
            sources: copySources,
            sourcesStatus: copySourcesStatus,
            source: copySource,
            sourceStatus: copySourceStatus,
            onLoadSources: maps.loadImportSources,
            onLoadSource: maps.loadImportSource,
          },
    [maps, copySources, copySourcesStatus, copySource, copySourceStatus],
  );

  return open !== null && actions !== null && mapImport !== null ? (
    <TournamentDetailPane
      event={open}
      actions={actions}
      onOpenPage={onOpenPage}
      onOpenUrl={openUrl}
      jump={jump}
      siteAdmin={siteAdmin}
      pastedImage={descImage}
      detailLoading={detailStatus.type === "loading"}
      series={series}
      events={events}
      profiles={entrantProfiles}
      articles={articles}
      assetBase={assetBase}
      vault={vault}
      vaultStatus={vaultStatus}
      chatRooms={chatRooms}
      openRoomId={openRoomId}
      chatPosts={chatPosts}
      chatStatus={chatStatus}
      pinnedRoomId={pinnedRoomId}
      pinnedPosts={pinnedPosts}
      busy={busy}
      busyMatchId={busyMatch}
      accountSearch={accountSearch}
      renames={renames}
      renamesStatus={renamesStatus}
      ratingCheck={ratingCheck}
      ratingCheckStatus={ratingCheckStatus}
      playerRatings={playerRatings}
      playerRatingsStatus={playerRatingsStatus}
      mapImport={mapImport}
    />
  ) : (
    <div className="surface tournaments-state muted">
      {detailStatus.type === "loading"
        ? t("tournaments.detailLoading")
        : t("tournaments.select")}
    </div>
  );
}
