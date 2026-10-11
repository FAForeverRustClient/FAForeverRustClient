// One replay opened out of a list: map, lineup, ratings, chat and analysis.
// The local library reaches this through `localReplayToVaultReplay`, which
// shapes a file on disk like a vault record so the panel has one input.
//
// The panel composes three parts: `useReplayDetailResources` (the local file,
// the vault lookup, details and analysis), `useReplayMapPreparation` (which map
// this is and how to get it on disk), and the sections in
// `ReplayDetailHero` and `ReplayDetailSections`.

import { useState } from "react";
import { Modal } from "../../design-system/Modal";
import { useOverlayLayer } from "../../design-system/useOverlayLayer";
import type { VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useGameRating } from "./useGameRating";
import type { PlayerMenuOpener } from "../../shared/hooks/usePlayerMenu";
import { ReplayInsights } from "./analysis/ReplayInsights";
import { isObserverTeam, playerCount } from "./ReplayRoster";
import { hasGameResult, localRatingNote, resultNote } from "./replayValidity";
import { useTranslation } from "../../i18n/useTranslation";
import { ReplayNotesDialog } from "./ReplayNotesEditor";
import { useReplayDetailResources } from "./useReplayDetailResources";
import { useReplayMapPreparation } from "./useReplayMapPreparation";
import { ReplayDetailHero, ReplayMapPreviewOverlay } from "./ReplayDetailHero";
import {
  ReplayDetailFacts,
  ReplayDetailLineup,
  ReplayDetailToolbar,
  ReplayGenerationNotice,
} from "./ReplayDetailSections";

export { localReplayToVaultReplay } from "./replayDetailPresentation";

export function ReplayDetailPanel({
  replay,
  busy,
  onClose,
  onWatch,
  onDownload,
  downloadState = "idle",
  downloadError = "",
  localPath: initialLocalPath,
  source = "online",
  watched = false,
  onToggleWatched,
  onPlayerMenu,
}: {
  replay: VaultReplay;
  busy: boolean;
  onClose: () => void;
  onWatch: () => void;
  onDownload?: () => void;
  downloadState?: "idle" | "downloading" | "downloaded" | "failed";
  downloadError?: string;
  localPath?: string;
  /**
   * Which catalogue the panel was opened from. Not derivable from `replay`:
   * `localReplayToVaultReplay` produces the same shape a vault listing has,
   * with the fields only the server knows left empty. The result section reads
   * those fields, so it has to know whether "empty" means "the server has not
   * said yet" or "a file on disk never carried it".
   */
  source?: "online" | "local";
  /// Whether this replay carries the watched mark, and how to turn it off.
  ///
  /// Watching a replay sets the mark, which is the only way it was ever set,
  /// and a mark that cannot be cleared is a mistake nobody can take back: a
  /// double click that landed as two single clicks marked a game the reader
  /// never watched. The panel is where a card can offer the switch at all,
  /// since a card is itself a button and cannot hold one.
  watched?: boolean;
  onToggleWatched?: () => void;
  /** Opens the chat player menu on a name in the lineup. */
  onPlayerMenu?: PlayerMenuOpener;
}) {
  const { t } = useTranslation();
  const isLocal = source === "local";
  const resources = useReplayDetailResources({ replay, initialLocalPath, isLocal });
  const { localMatch, onlineLookup, detailTeams, localPath, details, isLoadingDetails, detailsError, analysis } =
    resources;
  const map = useReplayMapPreparation({ replay, localMatch });
  const { effectiveMap, presentation } = map;

  const [copiedMapName, setCopiedMapName] = useState(false);
  /// Whether the map preview has been opened out of the rail.
  const [enlarged, setEnlarged] = useState(false);
  // The rail's button both asks for the file to be read and opens the panel
  // that shows what was in it, so its own open state is separate from whether
  // the details have arrived.
  const [showInsights, setShowInsights] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const totalPlayers = playerCount(detailTeams);
  // Java gates the whole result display on the game having been rated: its
  // "show rating change" button needs `validity == VALID` *and* a rating
  // journal with an "after", and the not-rated reason takes the button's place
  // otherwise. Showing outcomes regardless is what put "Defeat" on both sides
  // of a game nobody won and said nothing about why.
  // Optional on the wire: a listing from before this field existed carries
  // none, which reads as "no verdict yet" rather than as a refusal.
  //
  // A local replay takes the other branch: its `validity` is empty because the
  // conversion had nothing to put there, not because the server is still
  // deciding, so the online "not yet available" would be a straight untruth.
  const validity = onlineLookup?.type === "found"
    ? onlineLookup.payload.validity ?? ""
    : replay.validity ?? "";
  // Whether there is a result to show, not whether a rating moved: see
  // `hasGameResult`. A game the server has called valid and recorded outcomes
  // for has a winner worth showing whether or not the rating journal has
  // arrived, and gating this on the journal left a plainly rated game with a
  // dead "Game result" button and "Reason: VALID" underneath it.
  const rated = hasGameResult(validity, detailTeams);
  const notRated = isLocal
    ? localRatingNote(replay.uid, onlineLookup, detailTeams)
    : resultNote(validity, detailTeams);
  // The enlarged preview is a layer of the overlay stack above this panel's
  // `Modal`, so one press steps back out of the preview instead of shutting
  // the whole panel.
  useOverlayLayer(enlarged, () => setEnlarged(false));

  const competingTeams = detailTeams.filter((team) => !isObserverTeam(team.team)).length;
  const players = t("replays.detail.playerCount", { count: totalPlayers });
  // The lineup section's heading. "0 players" over the note that no lineup was
  // recorded would say the same thing twice, the first time wrongly.
  const lineupSummary = totalPlayers === 0
    ? t("replays.detail.lineup")
    : competingTeams > 1
      ? t("replays.detail.teamSummary", { teams: competingTeams, players })
      : players;
  const mapLabel = presentation.displayName || effectiveMap;
  const cardTitle = replay.title || mapLabel;
  // Fresh from the reviews panel once it has been open on this game: the
  // vault's own number is whatever the search that listed it returned.
  const rating = useGameRating(replay.uid, replay.reviewsAverage ?? null, replay.reviewsCount ?? null);
  const copyMapName = () =>
    ipc.run(navigator.clipboard.writeText(effectiveMap).then(() => setCopiedMapName(true)));
  return (
    <Modal className="replay-detail-modal replay-detail-modal-wide" ariaLabel={t("replays.detail.aria", { name: cardTitle })} onClose={onClose}>
      {/* The hero: the map as a dimmed backdrop across the top of the dialog,
          and in front of it the whole preview, what the replay is, and Watch.
          The backdrop is decoration only; the preview beside the title is the
          picture to recognise the map by, shown uncropped. */}
      <ReplayDetailHero
        replay={replay}
        busy={busy}
        onWatch={onWatch}
        map={map}
        mapLabel={mapLabel}
        cardTitle={cardTitle}
        copiedMapName={copiedMapName}
        onCopyMapName={copyMapName}
        onEnlarge={() => setEnlarged(true)}
      />

      <ReplayGenerationNotice
        status={map.mapGenStatus}
        running={map.isGeneratingThisMap}
        progress={map.generatorProgress}
      />
      {downloadState === "failed" && (
        <p className="replay-download-error surface-error">{t("replays.detail.downloadFailed", { error: downloadError })}</p>
      )}

      <ReplayDetailFacts
        replay={replay}
        totalPlayers={totalPlayers}
        size={map.size}
        rating={rating}
        cardTitle={cardTitle}
      />

      <ReplayDetailLineup
        lineupSummary={lineupSummary}
        rated={rated}
        notRated={notRated}
        teams={detailTeams}
        onPlayerMenu={onPlayerMenu}
      />

      <ReplayDetailToolbar
        replay={replay}
        onDownload={onDownload}
        downloadState={downloadState}
        localPath={localPath}
        onClose={onClose}
        watched={watched}
        onToggleWatched={onToggleWatched}
        showNotes={showNotes}
        onOpenNotes={() => setShowNotes(true)}
        showInsights={showInsights}
        onOpenInsights={() => {
          resources.requestInsights();
          setShowInsights(true);
        }}
        isLoadingDetails={isLoadingDetails}
      />

      {enlarged && (
        <ReplayMapPreviewOverlay
          mapThumbnailUrl={replay.mapThumbnailUrl}
          effectiveMap={effectiveMap}
          mapLabel={mapLabel}
          cardTitle={cardTitle}
          copiedMapName={copiedMapName}
          onCopyMapName={copyMapName}
          onClose={() => setEnlarged(false)}
        />
      )}

      {/* The overlays the secondary actions open. The insights panel opens on
          the click, not on the answer: the file may still have to be
          downloaded, and the panel says so while it is, where a button that
          waited for the answer looked like it had done nothing. */}
      {showNotes && (
        <ReplayNotesDialog replayId={replay.uid} title={cardTitle} onClose={() => setShowNotes(false)} />
      )}
      {showInsights && (
        <ReplayInsights
          details={details ?? null}
          analysis={analysis}
          analysisLoading={resources.analysisLoading}
          analysisError={resources.analysisError ?? ""}
          teams={detailTeams}
          title={cardTitle}
          mapPreviewUrl={map.heatmapPreviewUrl}
          mapAction={map.heatmapMapAction}
          loading={isLoadingDetails}
          error={detailsError ?? ""}
          onClose={() => setShowInsights(false)}
        />
      )}
      {detailsError && (
        <p className="replay-download-error surface-error">{detailsError}</p>
      )}
    </Modal>
  );
}
