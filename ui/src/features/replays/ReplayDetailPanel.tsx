// One replay opened out of a list: map, lineup, ratings, chat and analysis.
// The local library reaches this through `localReplayToVaultReplay`, which
// shapes a file on disk like a vault record so the panel has one input.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { useOverlayLayer } from "../../design-system/useOverlayLayer";
import type { CoopMission, LocalReplay, LocalReplayPlayer, LocalReplayTeam, VaultMap, VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatDate, formatTime } from "../../shared/format/dates";
import { formatDuration } from "../../shared/format/durations";
import { localReplayTimestamp } from "./local/localReplayQuery";
import {
  extractGeneratedMapSeed,
  effectiveReplayMapName,
  findVaultMap,
  isGeneratedMap,
  isGeneratedMapPlaceholderUrl,
  mapPresentation,
  mapSize,
  normalizeMapName,
} from "../../shared/mapPresentation";
import { MapPreviewFrame } from "../../shared/components/MapPreviewZoom";
import { onlineReplayLink } from "../../shared/replayLinks";
import { openReviews } from "../../shared/openReviews";
import { useGameRating } from "./useGameRating";
import type { PlayerMenuOpener } from "../../shared/hooks/usePlayerMenu";
import { replayMapPresentation } from "./coopReplayMap";
import { ReplayInsights } from "./analysis/ReplayInsights";
import { useAppStore } from "../../store/store";
import { isObserverTeam, playerCount, ReplayDetailRoster, mergeReplayTeamsWithLocal } from "./ReplayRoster";
import { hasGameResult, localRatingNote, resultNote } from "./replayValidity";
import { formatDecimal } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { ReplayMapThumb } from "./ReplayCard";
import { ReplayNotesDialog, useHasReplayNote } from "./ReplayNotesEditor";

export function localReplayToVaultReplay(
  local: LocalReplay,
  mapVault: VaultMap[],
  missions: CoopMission[] = [],
): VaultReplay {
  const presentation = local.map ? mapPresentation(mapVault, local.map, missions) : null;
  const timestamp = localReplayTimestamp(local);
  return {
    uid: local.uid ?? 0,
    title: local.title || local.fileName,
    map: presentation?.displayName || local.map || local.fileName,
    mapThumbnailUrl: presentation?.thumbnailUrl || "",
    modName: local.modName || "faf",
    startTime: timestamp > 0 ? new Date(timestamp).toISOString() : "",
    replayAvailable: local.watchable,
    durationSeconds: null,
    gameDurationSeconds: null,
    quality: null,
    reviewsAverage: null,
    reviewsCount: null,
    averageRating: local.averageRating,
    gameVersion: local.gameVersion,
    teams: local.teams.map((team: LocalReplayTeam) => ({
      team: team.team === "null" ? -1 : Number.parseInt(team.team, 10) || 0,
      players: team.players.map((player: LocalReplayPlayer) => ({
        name: player.name,
        faction: player.faction,
        rating: player.rating,
        country: player.country ?? null,
        outcome: "",
        score: null,
      })),
    })),
  };
}

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
  const maps = useAppStore((state) => state.state.maps);
  const missions = useAppStore((state) => state.state.coop.missions);
  const socialPlayers = useAppStore((state) => state.state.social.players);
  const localReplays = useAppStore((state) => state.state.replays.local);
  const mapGenStatus = useAppStore((state) => state.state.mapGenerator.status);
  const replayDetails = useAppStore((state) => state.state.replays.replayDetails);
  const detailsLoading = useAppStore((state) => state.state.replays.detailsLoading);
  const detailsError = useAppStore((state) => state.state.replays.detailsError);
  const heldAnalysis = useAppStore((state) => state.state.replays.analysis);
  const analysisLoading = useAppStore((state) => state.state.replays.analysisLoading);
  const analysisError = useAppStore((state) => state.state.replays.analysisError);
  const onlineLookups = useAppStore((state) => state.state.replays.onlineLookups);
  // Subscribed, not read once: the answer arrives from the vault after the
  // panel is already open, and the map is what the header of it says.
  const resolvedMap = useAppStore((state) => state.state.replays.resolvedMaps?.[replay.uid]);
  const offline = useAppStore((state) => state.state.auth.mode === "offline");
  const avatarByLogin = useMemo(() => {
    const avatars = new Map<string, string>();
    for (const player of socialPlayers) {
      if (player.avatarUrl) avatars.set(player.login.toLocaleLowerCase(), player.avatarUrl);
    }
    return avatars;
  }, [socialPlayers]);

  const localMatch = localReplays.find(
    (local) => (replay.uid > 0 && local.uid === replay.uid) || (initialLocalPath && local.path === initialLocalPath),
  );
  const isLocal = source === "local";
  // The vault's own record of this game, asked for only when the panel was
  // opened from the local library: it is the sole place a local replay's
  // rating change can come from. `undefined` until the answer lands.
  const onlineLookup = replay.uid > 0 ? onlineLookups?.[replay.uid] : undefined;
  useEffect(() => {
    if (!isLocal || replay.uid <= 0 || onlineLookup) return;
    ipc.send({ kind: "Replays", command: { type: "lookUpOnline", payload: { uid: replay.uid } } });
  }, [isLocal, replay.uid, onlineLookup]);
  // A found lookup is the richer source: it carries outcomes and rating
  // changes the file never had. The local header still fills in what the
  // vault leaves out (faction and rating for a player it did not list).
  const onlineTeams = onlineLookup?.type === "found" ? onlineLookup.payload.teams : null;
  const detailTeams = mergeReplayTeamsWithLocal(
    onlineTeams && onlineTeams.length > 0 ? onlineTeams : replay.teams,
    localMatch?.teams,
  );
  const localPath = initialLocalPath || localMatch?.path;
  const details = replay.uid ? replayDetails?.[replay.uid] : undefined;
  const isLoadingDetails = detailsLoading === replay.uid;

  const loadDetails = () => {
    ipc.send({
      kind: "Replays",
      command: {
        type: "loadDetails",
        payload: {
          uid: replay.uid,
          localPath,
        },
      },
    });
  };

  // Only this replay's answer. The store holds one analysis at a time, so a
  // panel opened after another must not draw the last one's orders.
  const analysis = heldAnalysis?.uid === replay.uid ? heldAnalysis : null;
  const loadAnalysis = () => {
    ipc.send({
      kind: "Replays",
      command: {
        type: "loadAnalysis",
        payload: {
          uid: replay.uid,
          localPath,
        },
      },
    });
  };

  // The vault names a generated map only generically, so the technical name,
  // seed and all, comes from the replay's own header: the downloaded file's,
  // or the first bytes of it read without saving anything (`resolveMaps`).
  const effectiveMap = effectiveReplayMapName(replay.map, localMatch?.map ?? resolvedMap);
  const isGenerated = isGeneratedMap(effectiveMap);
  const seed = extractGeneratedMapSeed(effectiveMap);
  // The picture of a generated map, once the generator has built one. Keyed
  // the three ways `ReplayMapThumb` keys it, because the store is written
  // from whichever spelling the caller had.
  const generatedPreview = useAppStore((state) => isGenerated
    ? state.state.mapGenerator.previews?.[effectiveMap]
      || state.state.mapGenerator.previews?.[normalizeMapName(effectiveMap)]
      || state.state.mapGenerator.previews?.[effectiveMap.toLowerCase()]
    : undefined);
  // A generated map's size is in its name, and decoding the name is one
  // command for the one replay this panel shows, as the live panel does. Only
  // once the whole name is known: a bare generator placeholder has no size.
  const decodedMap = useAppStore((state) => state.state.mapGenerator.decoded?.[effectiveMap]);
  useEffect(() => {
    if (!seed || decodedMap) return;
    ipc.send({
      kind: "MapGenerator",
      command: { type: "decodeNames", payload: { mapNames: [effectiveMap] } },
    });
  }, [seed, decodedMap, effectiveMap]);
  const size = mapSize(maps.vault, effectiveMap, decodedMap?.mapSize);

  const installed = maps.installed.some(
    (map) =>
      map.folderName.toLowerCase() === effectiveMap.toLowerCase() ||
      map.folderName.toLowerCase().startsWith(`${effectiveMap.toLowerCase()}.`),
  );
  const isGeneratingThisMap =
    mapGenStatus.type === "generating" ||
    mapGenStatus.type === "downloading" ||
    mapGenStatus.type === "resolvingVersion" ||
    mapGenStatus.type === "preparing";

  const generatorProgress = (() => {
    switch (mapGenStatus.type) {
      case "resolvingVersion":
      case "preparing":
        return {
          label: t("replays.detail.preparingGenerator"),
          percent: null,
        };
      case "downloading": {
        const { version, downloadedBytes, totalBytes } = mapGenStatus.payload;
        if (totalBytes && totalBytes > 0) {
          const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
          const dlMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
          const totMb = (totalBytes / (1024 * 1024)).toFixed(1);
          return {
            label: `${t("replays.detail.downloadingGenerator", { version })} (${dlMb}/${totMb} MB)`,
            percent: pct,
          };
        }
        return {
          label: t("replays.detail.downloadingGenerator", { version }),
          percent: null,
        };
      }
      case "generating": {
        const { detail } = mapGenStatus.payload;
        return {
          label: detail && detail.trim().length > 0
            ? detail
            : t("lobby.details.generatingMap"),
          percent: null,
        };
      }
      default:
        return null;
    }
  })();
  const vaultMap = findVaultMap(maps.vault, effectiveMap);
  const presentation = replayMapPresentation(
    maps.vault,
    missions,
    { map: effectiveMap, title: replay.title, modName: replay.modName },
    resolvedMap,
  );

  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedMapName, setCopiedMapName] = useState(false);
  const [showResults, setShowResults] = useState(false);
  /// Whether the map preview has been opened out of the rail.
  const [enlarged, setEnlarged] = useState(false);
  // The rail's button both asks for the file to be read and opens the panel
  // that shows what was in it, so its own open state is separate from whether
  // the details have arrived.
  const [showInsights, setShowInsights] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const hasNote = useHasReplayNote(replay.uid);

  // The header alone, not the replay (#395). This used to download the whole
  // file into the local replay folder, so opening any online game on a
  // generated map put it in the player's own library as if they had played
  // it. Java's local list is the replays folder, which only the client's own
  // recordings go into (`ReplayFileWriterImpl`).
  const resolvingMap = isGenerated && !seed && replay.replayAvailable && !localMatch && resolvedMap === undefined;
  useEffect(() => {
    if (!resolvingMap || replay.uid <= 0) return;
    ipc.send({ kind: "Replays", command: { type: "resolveMaps", payload: { uids: [replay.uid] } } });
  }, [resolvingMap, replay.uid]);

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

  const copyLink = () =>
    ipc.run(
      navigator.clipboard
        .writeText(onlineReplayLink(replay.uid))
        .then(() => setCopied(true)),
    );
  const copyReplayId = () =>
    ipc.run(
      navigator.clipboard
        .writeText(String(replay.uid))
        .then(() => setCopiedId(true)),
    );
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
  const stars = rating.average;
  const starsLabel = stars === null
    ? t("replays.detail.noRatingYet")
    : t("reviews.scoreAria", { score: stars.toFixed(1), of: 5 });
  const starIcons = [1, 2, 3, 4, 5].map((step) => (
    <Icon
      key={step}
      name="star"
      size={15}
      className={stars !== null && stars >= step - 0.5 ? "is-filled" : "is-empty"}
    />
  ));
  // Rebuilding a generated map from its seed, which is how a generated map is
  // obtained: there is nothing to download. Its own value because two places
  // offer it: the thumbnail, while the map is not on disk, and the heatmap,
  // which can still have no picture to draw its cells over after that.
  const generateAction = isGenerated
    ? {
        icon: isGeneratingThisMap ? "refresh" : "plus",
        label: isGeneratingThisMap
          ? t("lobby.details.generatingMap")
          : resolvingMap
            ? t("replays.detail.resolvingMap")
            : t("lobby.details.generateMap"),
        // Without a seed there is nothing to generate from; the header lookup
        // above is what finds one, and a failed lookup leaves nothing to try.
        disabled: isGeneratingThisMap || !seed,
        run: () => {
          if (seed) {
            ipc.send({ kind: "MapGenerator", command: { type: "generateNamed", payload: { mapName: effectiveMap } } });
          }
        },
      }
    : null;
  // The generate button sits in the thumbnail's corner, as it does on every
  // other generated-map thumbnail in the client: building the map is what
  // replaces the placeholder there.
  const thumbGenerateAction = installed ? null : generateAction;
  // A vault map that is not on disk is fetched from the line naming it.
  const downloadMap = !installed && !isGenerated && vaultMap
    ? () =>
        ipc.send({
          kind: "Maps",
          command: { type: "installMap", payload: { folderName: vaultMap.folderName, downloadUrl: vaultMap.downloadUrl } },
        })
    : null;
  const copyMapName = () =>
    ipc.run(navigator.clipboard.writeText(effectiveMap).then(() => setCopiedMapName(true)));
  // What the heatmap draws its cells over, and what to press when there is
  // nothing to draw them over yet. The placeholder a generated map carries is
  // not a preview: it is the picture that says there is no picture, and the
  // heat over it would read as heat over the map.
  const heatmapPreviewUrl = generatedPreview
    || (isGeneratedMapPlaceholderUrl(replay.mapThumbnailUrl) ? "" : replay.mapThumbnailUrl)
    || undefined;
  const heatmapMapAction = !heatmapPreviewUrl && generateAction
    ? {
        label: generateAction.label,
        disabled: generateAction.disabled,
        busy: isGeneratingThisMap,
        run: generateAction.run,
      }
    : undefined;
  return (
    <Modal className="replay-detail-modal" ariaLabel={t("replays.detail.aria", { name: cardTitle })} onClose={onClose}>
      {/* One head across the dialog: the map, what the replay is, and the
          actions on the file. Below it, top to bottom, is what happened in the
          game: the facts, then the lineup, and at the floor the two ways
          further in, More info and Watch. A reader scans one column instead of
          crossing between a rail and a main column. */}
      <header className="replay-detail-head replay-detail-head-top">
        {/* A picture to recognise the map by, and a way to look at it
            properly: clicking opens the same zoom frame the Play and Maps tabs
            use. It is not a zoom widget in place, because a wheel handler over
            it swallowed the scroll of the dialog behind. */}
        <div className="replay-detail-thumb-frame">
          <button
            type="button"
            className="replay-detail-thumb-open"
            onClick={() => setEnlarged(true)}
            title={t("maps.preview.enlarge", { name: mapLabel })}
            aria-label={t("maps.preview.enlarge", { name: mapLabel })}
          >
            <ReplayMapThumb
              url={replay.mapThumbnailUrl}
              mapName={effectiveMap}
              className="replay-detail-thumb"
              emptyClassName="replay-detail-thumb-empty"
              iconSize={40}
              large
            />
            <span className="replay-detail-thumb-zoom" aria-hidden>
              <Icon name="search" size={14} />
            </span>
          </button>
          {/* Beside the preview button rather than inside it, since a button
              cannot hold another. */}
          {thumbGenerateAction && (
            <button
              type="button"
              className="replay-detail-thumb-generate"
              disabled={thumbGenerateAction.disabled}
              onClick={thumbGenerateAction.run}
              title={thumbGenerateAction.label}
              aria-label={thumbGenerateAction.label}
            >
              <Icon
                name={thumbGenerateAction.icon as IconName}
                size={14}
                className={isGeneratingThisMap ? "spin" : undefined}
              />
            </button>
          )}
        </div>

        <div className="replay-detail-headtext">
          <h2 title={cardTitle}>{cardTitle}</h2>
          <div className="replay-detail-map">
            <Icon name="maps" size={15} />
            <span className="replay-detail-map-name">{mapLabel}</span>
            {/* A generated map's whole name, copied rather than shown. It is
                `neroxis_map_generator_<version>_<seed>_<options>` and all three
                parts are needed to rebuild it: the same seed under a different
                version is a different map, and the generator dialog's
                Reproduce field rejects a bare seed. Printed out it was three
                lines of Base32 nobody reads; the tooltip and the enlarged
                preview both show it in full. */}
            {seed && (
              <button
                type="button"
                className="replay-card-icon-btn"
                aria-label={t(copiedMapName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
                title={copiedMapName
                  ? t("lobby.browser.mapNameCopied")
                  : `${t("lobby.browser.copyMapName")}\n${effectiveMap}`}
                onClick={copyMapName}
              >
                <Icon name={copiedMapName ? "check" : "copy"} size={13} />
              </button>
            )}
            {downloadMap && (
              <Button className="replay-detail-map-action" onClick={downloadMap}>
                <Icon name="download" size={13} />
                <span>{t("lobby.details.downloadMap")}</span>
              </Button>
            )}
          </div>
          {/* The number people quote at each other, and the two things done
              with it: copy the number, copy the link. A line under the map
              rather than a label over the title, so the title starts level
              with the top of the preview. */}
          <div className="replay-detail-idline">
            {replay.uid > 0 ? (
              <>
                <span className="replay-detail-id">#{replay.uid}</span>
                <button
                  type="button"
                  className="replay-card-icon-btn"
                  aria-label={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
                  title={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
                  onClick={copyReplayId}
                >
                  <Icon name={copiedId ? "check" : "copy"} size={13} />
                </button>
                <button
                  type="button"
                  className="replay-card-icon-btn"
                  aria-label={t(copied ? "replays.detail.copiedShort" : "replays.detail.copyLink")}
                  title={t(copied ? "replays.detail.copiedShort" : "replays.detail.copyLink")}
                  onClick={copyLink}
                >
                  <Icon name={copied ? "check" : "external"} size={13} />
                </button>
              </>
            ) : (
              <span>{t("replays.local.noReplayId")}</span>
            )}
          </div>
          {!replay.replayAvailable && (
            <div className="replay-detail-badges">
              <span className="replay-availability pending">{t("replays.detail.processing")}</span>
            </div>
          )}
        </div>

        {/* The actions on the file, one above the other in the order they
            are reached for. Watch is not among them: it sits at the floor of
            the dialog, opposite More info. */}
        <div className="replay-detail-actions">
          <div className="replay-detail-actions-secondary replay-detail-actions-stacked">
            {onDownload && (
              <Button
                className="replay-secondary-btn"
                disabled={!replay.replayAvailable || downloadState === "downloading" || downloadState === "downloaded"}
                onClick={onDownload}
                title={t("replays.detail.downloadReplay")}
              >
                <Icon name="download" size={13} />
                <span>{t(downloadState === "downloading"
                  ? "replays.detail.downloading"
                  : downloadState === "downloaded"
                    ? "replays.detail.downloaded"
                    : "replays.detail.downloadShort")}</span>
              </Button>
            )}
            {/* Watching sets the mark, and a mark that cannot be cleared is a
                mistake nobody can take back, so the panel carries the switch:
                a card is itself a button and cannot hold one. A toggle keeps
                one name and says its state by being pressed; the tooltip says
                what pressing it again does. */}
            {onToggleWatched && (
              <Button
                className={watched ? "replay-secondary-btn is-on" : "replay-secondary-btn"}
                aria-pressed={watched}
                onClick={onToggleWatched}
                title={t(watched ? "replays.watched.unmark" : "replays.watched.mark")}
              >
                <Icon name={watched ? "check" : "eye"} size={13} />
                <span>{t("replays.watched.mark")}</span>
              </Button>
            )}
            {/* The reader's own comment and tags (#324), in an overlay: most
                replays have none. Lit when there is a note, so a tagged game
                says so before it is opened. */}
            {replay.uid > 0 && (
              <Button
                className={hasNote ? "replay-secondary-btn is-on" : "replay-secondary-btn"}
                aria-haspopup="dialog"
                aria-expanded={showNotes}
                onClick={() => setShowNotes(true)}
                title={t("replays.notes.open")}
              >
                <Icon name="edit" size={13} />
                <span>{t("replays.notes.open")}</span>
              </Button>
            )}
            {/* The shortest path from "that game went badly" to a request
                someone can answer. Naming the replay rather than passing the
                details is deliberate: the training service reads them back out
                of state, so this button cannot prefill the form with anything
                the client does not actually know. */}
            <Button
              className="replay-secondary-btn"
              title={t("replays.detail.requestReview")}
              onClick={() => {
                ipc.send({
                  kind: "Training",
                  command: {
                    type: "openReview",
                    payload: {
                      replayUid: replay.uid > 0 ? replay.uid : null,
                      localPath: localPath ?? null,
                    },
                  },
                });
                ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "training" } } });
                onClose();
              }}
            >
              <Icon name="book" size={13} />
              <span>{t("replays.detail.requestReviewShort")}</span>
            </Button>
          </div>
        </div>
      </header>

      {isGeneratingThisMap && generatorProgress && (
        <div className="replay-generation-banner">
          <div className="replay-generation-banner-content">
            <Icon name="refresh" size={14} className="spin replay-generation-spinner" />
            <span className="replay-generation-banner-text">{generatorProgress.label}</span>
            {generatorProgress.percent !== null && (
              <span className="replay-generation-banner-pct">{generatorProgress.percent}%</span>
            )}
          </div>
          {generatorProgress.percent !== null ? (
            <div className="replay-generation-progress-track">
              <div
                className="replay-generation-progress-fill"
                style={{ transform: `scaleX(${generatorProgress.percent / 100})` }}
              />
            </div>
          ) : (
            <div className="replay-generation-progress-track indeterminate">
              <div className="replay-generation-progress-fill" />
            </div>
          )}
        </div>
      )}
      {mapGenStatus.type === "failed" && (
        <p className="replay-download-error surface-error">
          {t("replays.detail.generationFailed", { error: mapGenStatus.payload.reason })}
        </p>
      )}
      {downloadState === "failed" && (
        <p className="replay-download-error surface-error">{t("replays.detail.downloadFailed", { error: downloadError })}</p>
      )}

      {/* Ten facts in two rows of five, paired by column: date over time,
          the two durations (routinely minutes apart, and the difference is
          the point of showing both), players over mod, the two numbers about
          the game's standing, and the map's size over the community's score
          for the replay. */}
      <dl className="replay-detail-facts replay-detail-facts-five">
        <div><dt>{t("replays.detail.date")}</dt><dd>{formatDate(replay.startTime, t("replays.detail.unknown"))}</dd></div>
        <div><dt>{t("replays.detail.realTime")}</dt><dd>{replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.players")}</dt><dd>{totalPlayers}</dd></div>
        <div><dt>{t("replays.detail.avgRating")}</dt><dd>{replay.averageRating !== null ? replay.averageRating : t("replays.detail.unrated")}</dd></div>
        <div><dt>{t("replays.filters.mapSize")}</dt><dd>{size ? size.compact : t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.time")}</dt><dd>{formatTime(replay.startTime, t("replays.detail.unknown"))}</dd></div>
        <div><dt>{t("replays.detail.gameTime")}</dt><dd>{replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.featuredMod")}</dt><dd>{replay.modName || t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.quality")}</dt><dd>{replay.quality !== null ? `${replay.quality}%` : t("replays.detail.unknown")}</dd></div>
        {/* The stars open the game's reviews, where it can be rated: the same
            panel the map and mod vaults use, on FAF's gameReview resource
            (issue 351). A game the server has no number for, or a session
            without the API, has nothing to open, so there it stays a label. */}
        <div>
          <dt>{t("maps.vault.communityRating")}</dt>
          {/* No score, no stars: five empty stars read as a score of zero.
              The word alone stays the way in, so a replay nobody has rated
              can still be rated from here. */}
          <dd className="replay-detail-rating">
            {stars === null ? (
              replay.uid > 0 && !offline ? (
                <button
                  type="button"
                  className="replay-detail-stars-button replay-detail-rating-value"
                  title={t("replays.detail.rateReplay")}
                  aria-label={`${t("replays.detail.rateReplay")}: ${starsLabel}`}
                  onClick={() => openReviews("game", replay.uid, cardTitle)}
                >
                  {t("replays.detail.unrated")}
                </button>
              ) : (
                <span className="replay-detail-rating-value">{t("replays.detail.unrated")}</span>
              )
            ) : (
              <>
                {replay.uid > 0 && !offline ? (
                  <button
                    type="button"
                    className="replay-detail-stars replay-detail-stars-button"
                    title={t("replays.detail.rateReplay")}
                    aria-label={`${t("replays.detail.rateReplay")}: ${starsLabel}`}
                    onClick={() => openReviews("game", replay.uid, cardTitle)}
                  >
                    {starIcons}
                  </button>
                ) : (
                  <span className="replay-detail-stars" role="img" aria-label={starsLabel}>
                    {starIcons}
                  </span>
                )}
                <span className="replay-detail-rating-value">
                  {formatDecimal(stars)}
                  {rating.count ? (
                    <span className="muted"> · {rating.count}</span>
                  ) : null}
                </span>
              </>
            )}
          </dd>
        </div>
      </dl>

      <section className="replay-detail-lineup" aria-label={lineupSummary}>
        <div className="replay-detail-section-head">
          <h3>{lineupSummary}</h3>
          {/* The result switch, with the reason it is missing in its place.
              There is no dead button: a game with no result to show says why
              instead, and an unrated game with a decisive outcome has both a
              winner and a reason it did not count (see `hasGameResult`). */}
          <div className="replay-detail-result">
            {(!rated || notRated !== null) && (
              <p className="replay-detail-result-reason">
                <Icon name="info" size={14} />
                <span>{notRated ?? t("replays.detail.noResultYet")}</span>
              </p>
            )}
            {rated && (
              <Button
                className="replay-detail-reveal-btn"
                aria-pressed={showResults}
                onClick={() => setShowResults((visible) => !visible)}
              >
                <Icon name="eye" size={13} />
                <span>{t(showResults ? "replays.detail.hideResults" : "replays.detail.gameResult")}</span>
              </Button>
            )}
          </div>
        </div>
        {detailTeams.length > 0 ? (
          <ReplayDetailRoster
            teams={detailTeams}
            showResults={showResults}
            avatarByLogin={avatarByLogin}
            onPlayerMenu={onPlayerMenu}
          />
        ) : (
          <p className="replay-detail-empty muted">{t("replays.detail.noLineup")}</p>
        )}
      </section>

      {/* What the replay file itself holds, under the lineup it goes deeper
          into rather than among the actions on the file: chat, options, mods
          and the analysis tabs. Watch takes the other end of the same row,
          the bottom-right corner where a dialog's main action is looked for. */}
      <div className="replay-detail-foot">
        <Button
          className="replay-secondary-btn replay-detail-more-info"
          onClick={() => {
            // Both reads, in the order they are wanted. The file is fetched
            // once and the second walk reads it off disk, so the expensive
            // half costs the reader nothing until they reach a tab that
            // needs it.
            if (!details && !isLoadingDetails) loadDetails();
            if (!analysis && analysisLoading !== replay.uid) loadAnalysis();
            setShowInsights(true);
          }}
          aria-haspopup="dialog"
          aria-expanded={showInsights}
          title={t("replays.insights.openHint")}
        >
          <Icon name={isLoadingDetails ? "refresh" : "list"} size={13} className={isLoadingDetails ? "spin" : undefined} />
          <span>{t("replays.detail.loadDetailsShort")}</span>
        </Button>
        <Button
          className="replay-watch-button"
          variant="primary"
          disabled={busy || !replay.replayAvailable}
          onClick={onWatch}
        >
          <Icon name="play" size={15} />
          <span>{t(replay.replayAvailable ? "replays.detail.watch" : "replays.detail.notUploaded")}</span>
        </Button>
      </div>

      {/* The enlarged preview, in this dialog's own markup rather than in a
          second `Modal`. It covers the viewport the way a dialog would, and
          leaves the same three ways out: the button, the scrim, and Escape. */}
      {enlarged && (
        <div
          className="replay-preview-scrim"
          role="presentation"
          onClick={() => setEnlarged(false)}
        >
          <div
            className="replay-preview-overlay"
            role="dialog"
            aria-label={t("maps.preview.enlarge", { name: mapLabel })}
            onClick={(event) => event.stopPropagation()}
          >
            {/* The same frame the Play tab and the Maps tab open a map in, so
                a preview looks like a preview wherever it was reached from.
                The technical name under it is what the Play tab's preview has
                too. */}
            <MapPreviewFrame
              kicker={t("lobby.browser.mapPreview")}
              title={mapLabel}
              subtitle={cardTitle === mapLabel ? undefined : cardTitle}
              onClose={() => setEnlarged(false)}
              footer={effectiveMap ? (
                <div className="replay-preview-overlay-name">
                  <span>{t("lobby.browser.mapFullName")}</span>
                  <code>{effectiveMap}</code>
                  <button
                    type="button"
                    className="replay-card-icon-btn"
                    aria-label={t(copiedMapName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
                    title={t(copiedMapName ? "lobby.browser.mapNameCopied" : "lobby.browser.copyMapName")}
                    onClick={copyMapName}
                  >
                    <Icon name={copiedMapName ? "check" : "copy"} size={13} />
                  </button>
                </div>
              ) : null}
            >
              <ReplayMapThumb
                url={replay.mapThumbnailUrl}
                mapName={effectiveMap}
                className="replay-preview-overlay-image"
                emptyClassName="replay-detail-thumb-empty"
                iconSize={64}
                large
              />
            </MapPreviewFrame>
          </div>
        </div>
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
          analysisLoading={analysisLoading === replay.uid}
          analysisError={analysisError ?? ""}
          teams={detailTeams}
          title={cardTitle}
          mapPreviewUrl={heatmapPreviewUrl}
          mapAction={heatmapMapAction}
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
