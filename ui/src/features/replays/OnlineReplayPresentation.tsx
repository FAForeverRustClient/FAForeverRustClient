import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type {
  CoopMission,
  LocalReplay,
  LocalReplayPlayer,
  LocalReplayTeam,
  ReplayTeam,
  VaultMap,
  VaultReplay,
} from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatAgeOrDate, formatDate, formatShortDate, formatTime } from "../../shared/dates";
import { formatDuration } from "../../shared/durations";
import { localReplayTimestamp } from "./localReplayQuery";
import {
  extractGeneratedMapSeed,
  effectiveReplayMapName,
  findVaultMap,
  isGeneratedMap,
  isGeneratedMapPlaceholderUrl,
  mapPresentation,
  mapThumbnailCandidates,
  normalizeMapName,
} from "../../shared/mapPresentation";
import { MapPreviewFrame } from "../maps/MapPreviewZoom";
import { onlineReplayLink } from "../../shared/replayLinks";
import { replayMapKey, replayMapPresentation } from "./coopReplayMap";
import { ReplayInsights } from "./ReplayInsights";
import { useAppStore } from "../../store/store";
import {
  isObserverTeam,
  playerCount,
  ReplayCardRoster,
  ReplayDetailRoster,
  mergeReplayTeamsWithLocal,
} from "./ReplayRoster";
import { isRated, localRatingNote, notRatedReason } from "./replayValidity";
import {
  formatReplayListTime,
  ReplayList,
  type ReplayListGroup,
} from "./ReplayList";
import { formatDecimal, t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * "3d ago" beside the replay id, so recency reads without parsing a date --
 * and the date itself once "how long ago" has stopped being readable.
 */
function replayAge(startTime: string): string {
  return formatAgeOrDate(startTime);
}

/**
 * The selector's answer when nothing has been resolved yet.
 *
 * A literal `{}` inside the selector would be a new object on every render,
 * which is a new value to the store's identity check and a render loop.
 */
const NO_RESOLVED_MAPS: Record<number, string> = {};

export interface ReplayCardData {
  /** The game id, which is what a map read out of the replay file is keyed by. */
  uid: number;
  idLabel: string;
  title: string;
  map: string;
  mapThumbnailUrl: string;
  modName: string;
  startTime: string;
  teams: ReplayTeam[];
  averageRating: number | null;
  gameDurationSeconds: number | null;
  durationSeconds: number | null;
  reviewsAverage: number | null;
  reviewsCount: number | null;
  footerNote: string;
}

function ReplayStars({ replay }: { replay: ReplayCardData }) {
  if (replay.reviewsCount == null || replay.reviewsCount === 0) return null;
  return (
    <span className="replay-stars">
      {"★".repeat(Math.round(replay.reviewsAverage ?? 0))} ({replay.reviewsCount})
    </span>
  );
}

/**
 * The card's own way in: watch this replay, without opening it first.
 *
 * Watching meant opening the card, reading a panel and pressing the button at
 * the bottom of it, which is three steps to do the one thing the grid is being
 * scanned for. It sits in the bottom corner of the card next to the replay id,
 * where a card puts what it can do, rather than over the map: a control on top
 * of the picture hides part of the one thing the tile is mostly made of.
 *
 * Only watching. Downloading a replay is a thing you do to one replay you have
 * already decided on, not something to offer on every tile of a page of fifty;
 * it stays in the detail panel and on the list view's row.
 */
export interface ReplayCardWatch {
  label: string;
  ariaLabel: string;
  disabled: boolean;
  onClick: () => void;
}

const REPLAY_CARD_TITLE_LIMIT = 48;

export function replayCardTitle(title: string, fallback: string): { full: string; display: string } {
  const full = title || fallback;
  return {
    full,
    display: full.length > REPLAY_CARD_TITLE_LIMIT
      ? `${full.slice(0, REPLAY_CARD_TITLE_LIMIT - 1)}…`
      : full,
  };
}

// Mirrors the Java client's replay_card.fxml: a 2-column icon-less meta grid
// (date/players, mod/rating, duration) below the thumbnail.
export function ReplayMetaFact({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <span className="replay-meta-fact" title={label}>
      <Icon name={icon} size={13} />
      <span>{value || "N/A"}</span>
    </span>
  );
}

function ReplayMetaGrid({ replay }: { replay: ReplayCardData }) {
  const { t } = useTranslation();
  return (
    <div className="replay-meta-grid muted">
      <ReplayMetaFact icon="calendar" label={t("replays.card.played")} value={formatDate(replay.startTime, "")} />
      <ReplayMetaFact icon="users" label={t("replays.card.players")} value={`${playerCount(replay.teams)}`} />
      <ReplayMetaFact icon="mods" label={t("replays.card.featuredMod")} value={replay.modName} />
      <ReplayMetaFact
        icon="activity"
        label={t("replays.card.averageRating")}
        value={replay.averageRating !== null ? `~${replay.averageRating}` : ""}
      />
      {/* The two durations are routinely minutes apart, so each carries its own
          glyph rather than a trailing "game"/"real" word: the pairing the Java
          card uses (`game-duration-icon` / `world-duration-icon`). */}
      <ReplayMetaFact
        icon="hourglass"
        label={t("replays.card.gameTime")}
        value={replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : ""}
      />
      <ReplayMetaFact
        icon="clock"
        label={t("replays.card.realTime")}
        value={replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : ""}
      />
    </div>
  );
}

export function ReplayMapThumb({
  url,
  mapName,
  className,
  emptyClassName,
  iconSize = 24,
  large = false,
}: {
  url: string | null | undefined;
  mapName: string;
  className: string;
  emptyClassName: string;
  iconSize?: number;
  large?: boolean;
}) {
  const vault = useAppStore((state) => state.state.maps.vault);
  const isGenerated =
    isGeneratedMap(mapName) ||
    isGeneratedMapPlaceholderUrl(url);
  const normalized = normalizeMapName(mapName);
  const generatedPreview = useAppStore((state) =>
    isGenerated
      ? state.state.mapGenerator.previews?.[mapName] ||
        state.state.mapGenerator.previews?.[normalized] ||
        state.state.mapGenerator.previews?.[mapName.toLowerCase()]
      : undefined,
  );
  // Subscribed rather than read through the shared fallback: the mission
  // catalogue loads after this renders, and a mission's artwork is the only
  // preview a campaign map has.
  const missions = useAppStore((state) => state.state.coop.missions);
  const candidates = useMemo(
    () => mapThumbnailCandidates(vault, mapName, large, missions, generatedPreview, url || undefined),
    [generatedPreview, large, mapName, missions, url, vault],
  );
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => setCandidateIndex(0), [candidates]);

  const currentUrl = candidates[candidateIndex];

  if (!currentUrl) {
    return (
      <div className={`${className} ${emptyClassName}`} aria-hidden="true">
        <Icon name="maps" size={iconSize} />
      </div>
    );
  }

  return (
    <img
      className={className}
      src={currentUrl}
      alt={`${mapName} preview`}
      loading="lazy"
      decoding="async"
      onError={() => setCandidateIndex((index) => index + 1)}
    />
  );
}

export function ReplayLibraryCard({
  replay,
  watched,
  selected = false,
  watch,
  onOpen,
  onDoubleClick,
}: {
  replay: ReplayCardData;
  watched: boolean;
  selected?: boolean;
  /** The footer's action. See `ReplayCardWatch`. */
  watch?: ReplayCardWatch;
  onOpen: () => void;
  onDoubleClick?: () => void;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const missions = useAppStore((state) => state.state.coop.missions);
  // What the replay file said, when it has been read. Empty until it has, and
  // empty for good if the file could not be read, which is why the fallbacks
  // inside these two stay.
  const resolved = useAppStore((state) => state.state.replays.resolvedMaps?.[replay.uid]);
  const presentation = replayMapPresentation(vault, missions, replay, resolved);
  const mapKey = replayMapKey(missions, replay, resolved);
  const cardTitle = replayCardTitle(replay.title, presentation.displayName || replay.map);
  const stateClasses = [watched && "replay-card-watched", selected && "replay-card-selected"]
    .filter(Boolean)
    .join(" ");
  return (
    /* A `div` with the role rather than a `button`: the actions over the
       thumbnail are buttons themselves, and a button inside a button is
       neither valid nor clickable. Enter and Space are handled here, and only
       when the card itself has the focus, so a press on one of those actions
       is not also a press on the card behind it. */
    <div
      className={`replay-card surface-panel surface-interactive ${stateClasses}`.trim()}
      role="button"
      tabIndex={0}
      aria-pressed={selected || undefined}
      onClick={onOpen}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <div className="replay-card-left">
        <ReplayMapThumb
          url={replay.mapThumbnailUrl}
          mapName={mapKey}
          className="replay-card-thumb"
          emptyClassName="replay-card-thumb-empty"
          iconSize={32}
        />
        <ReplayStars replay={replay} />
        <ReplayMetaGrid replay={replay} />
      </div>
      <div className="replay-card-right">
        <div className="replay-card-header">
          <span className="replay-card-title" title={cardTitle.full} aria-label={cardTitle.full}>{cardTitle.display}</span>
          <span className="replay-card-submap muted">{t("replays.card.onMap", { map: presentation.displayName || replay.map })}</span>
        </div>
        <ReplayCardRoster teams={replay.teams} />
        {/* The id and the way in, on one line in the corner: the label that
            says which replay this is, and the button that plays it. */}
        <div className="replay-card-footer">
          {replay.footerNote && <span className="muted">{replay.footerNote}</span>}
          <span className="muted">{replay.idLabel}</span>
          {watch && (
            <button
              type="button"
              className="replay-card-watch"
              disabled={watch.disabled}
              aria-label={watch.ariaLabel}
              title={watch.ariaLabel}
              // The card opens on a click and watches on a double click, and
              // neither is what was asked for here.
              onClick={(event) => {
                event.stopPropagation();
                watch.onClick();
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <Icon name="play" size={13} />
              <span>{watch.label}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ReplayCard({
  replay,
  watched,
  busy = false,
  onOpen,
  onDoubleClick,
  onWatch,
}: {
  replay: VaultReplay;
  watched: boolean;
  /** A game is already starting, so a second "watch" would go nowhere. */
  busy?: boolean;
  onOpen: () => void;
  onDoubleClick?: () => void;
  onWatch?: () => void;
}) {
  const { t } = useTranslation();
  const localReplays = useAppStore((state) => state.state.replays.local);
  const localMatch = localReplays.find((local) => local.uid === replay.uid);
  const map = effectiveReplayMapName(replay.map, localMatch?.map);
  // Absent for a replay the server has not finished processing, because it
  // would not work. Same rule as the list view.
  const watch: ReplayCardWatch | undefined = onWatch && replay.replayAvailable
    ? {
      label: t("replays.detail.watch"),
      ariaLabel: t("replays.list.watchAria", { name: replay.title || map }),
      disabled: busy,
      onClick: onWatch,
    }
    : undefined;
  return (
    <ReplayLibraryCard
      replay={{
        uid: replay.uid,
        idLabel: `#${replay.uid}`,
        title: replay.title,
        map,
        mapThumbnailUrl: replay.mapThumbnailUrl,
        modName: replay.modName,
        startTime: replay.startTime,
        teams: mergeReplayTeamsWithLocal(replay.teams, localMatch?.teams),
        averageRating: replay.averageRating,
        gameDurationSeconds: replay.gameDurationSeconds,
        durationSeconds: replay.durationSeconds,
        reviewsAverage: replay.reviewsAverage,
        reviewsCount: replay.reviewsCount,
        footerNote: replay.replayAvailable ? "" : t("replays.card.notUploaded"),
      }}
      watched={watched}
      watch={watch}
      onOpen={onOpen}
      onDoubleClick={onDoubleClick}
    />
  );
}

export function OnlineReplayList({
  replays,
  groupByDate = true,
  selectedUid,
  watchedUids,
  onSelect,
  onOpen,
  onWatch,
  onDownload,
  onToggleWatched,
}: {
  replays: VaultReplay[];
  groupByDate?: boolean;
  selectedUid: number | null;
  watchedUids: Set<number>;
  onSelect: (uid: number) => void;
  onOpen: (uid: number) => void;
  onWatch?: (uid: number) => void;
  /** Saves the `.fafreplay` file, without opening the detail panel first. */
  onDownload?: (uid: number) => void;
  onToggleWatched?: (uid: number) => void;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const missions = useAppStore((state) => state.state.coop.missions);
  const resolvedMaps = useAppStore((state) => state.state.replays.resolvedMaps ?? NO_RESOLVED_MAPS);
  const localReplays = useAppStore((state) => state.state.replays.local);
  const groups = groupByDate
    ? groupReplaysByDate(replays)
    : [{ label: t("replays.list.results"), replays }];

  const listGroups: ReplayListGroup[] = groups.map((group) => ({
    label: group.label,
    rows: group.replays.map((replay) => {
      const map = effectiveReplayMapName(replay.map, localReplays.find((local) => local.uid === replay.uid)?.map);
      const resolved = resolvedMaps[replay.uid];
      const presentation = replayMapPresentation(vault, missions, { ...replay, map }, resolved);
      return {
        key: String(replay.uid),
        mapName: replayMapKey(missions, { ...replay, map }, resolved),
        mapThumbnailUrl: replay.mapThumbnailUrl,
        game: {
          primary: replay.title || presentation.displayName || map,
          secondary: presentation.displayName || map || t("replays.list.mapUnavailable"),
        },
        played: {
          primary: formatReplayListTime(replay.startTime),
          secondary: replayAge(replay.startTime) || "N/A",
        },
        players: { primary: String(playerCount(replay.teams)) },
        rating: { primary: replay.averageRating === null ? "N/A" : String(replay.averageRating) },
        mod: {
          primary: replay.modName || "faf",
          secondary: replay.reviewsCount
            ? `★ ${replay.reviewsAverage?.toFixed(1) ?? "N/A"} (${replay.reviewsCount})`
            : undefined,
        },
        duration: {
          primary: replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : "N/A",
          secondary: replay.durationSeconds !== null
            ? t("replays.list.realTimeSuffix", { duration: formatDuration(replay.durationSeconds) })
            : t("replays.list.realTimeUnavailable"),
        },
        replay: {
          primary: t(replay.replayAvailable ? "replays.list.available" : "replays.list.processing"),
          secondary: `#${replay.uid}`,
          tone: replay.replayAvailable ? "ok" : "warn",
        },
        selected: selectedUid === replay.uid,
        watched: watchedUids.has(replay.uid),
        onSelect: () => onSelect(replay.uid),
        onActivate: () => {
          if (onWatch && replay.replayAvailable) onWatch(replay.uid);
          else onOpen(replay.uid);
        },
        action: {
          label: t("replays.list.details"),
          ariaLabel: t("replays.list.detailsAria", { uid: replay.uid }),
          onClick: () => onOpen(replay.uid),
        },
        // Watch and Download on the row itself, which is what the thread
        // asked for: both were a detail panel away, and both are the reason
        // somebody is looking at the row in the first place. Neither appears
        // for a replay the server has not finished processing, because
        // neither would work.
        iconActions: [
          ...(onWatch && replay.replayAvailable
            ? [{
              icon: "play" as const,
              ariaLabel: t("replays.list.watchAria", { name: replay.title || map }),
              title: t("replays.detail.watch"),
              onClick: () => onWatch(replay.uid),
            }]
            : []),
          ...(onDownload && replay.replayAvailable
            ? [{
              icon: "download" as const,
              ariaLabel: t("replays.list.downloadAria", { name: replay.title || map }),
              title: t("replays.detail.download"),
              onClick: () => onDownload(replay.uid),
            }]
            : []),
          ...(onToggleWatched
            ? [{
              icon: "eye" as const,
              pressed: watchedUids.has(replay.uid),
              ariaLabel: t(watchedUids.has(replay.uid)
                ? "replays.watched.unmarkAria"
                : "replays.watched.markAria", { name: replay.title || map }),
              title: t(watchedUids.has(replay.uid) ? "replays.watched.unmark" : "replays.watched.mark"),
              onClick: () => onToggleWatched(replay.uid),
            }]
            : []),
        ],
      };
    }),
  }));

  return (
    <ReplayList
      groups={listGroups}
      footer={<><span>{t("replays.list.count", { count: replays.length })}</span><span>{t("replays.list.selectHint")}</span></>}
    />
  );
}

function groupReplaysByDate(replays: VaultReplay[]): Array<{ label: string; replays: VaultReplay[] }> {
  const groups: Array<{ label: string; replays: VaultReplay[] }> = [];
  for (const replay of replays) {
    const label = formatShortDate(replay.startTime, t("replays.list.unknownDate"));
    const current = groups[groups.length - 1];
    if (current?.label === label) current.replays.push(replay);
    else groups.push({ label, replays: [replay] });
  }
  return groups;
}

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

  const effectiveMap = effectiveReplayMapName(replay.map, localMatch?.map);
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
  const [copiedSeed, setCopiedSeed] = useState(false);
  const [copiedMapName, setCopiedMapName] = useState(false);
  const [showResults, setShowResults] = useState(false);
  /// Whether the map preview has been opened out of the rail.
  const [enlarged, setEnlarged] = useState(false);
  // The rail's button both asks for the file to be read and opens the panel
  // that shows what was in it, so its own open state is separate from whether
  // the details have arrived.
  const [showInsights, setShowInsights] = useState(false);

  useEffect(() => {
    if (isGenerated && !seed && replay.replayAvailable && !localMatch && downloadState === "idle") {
      ipc.send({
        kind: "Replays",
        command: {
          type: "downloadVault",
          payload: { uid: replay.uid },
        },
      });
    }
  }, [isGenerated, seed, replay.replayAvailable, replay.uid, localMatch, downloadState]);

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
  const rated = isRated(validity, detailTeams);
  const notRated = isLocal
    ? localRatingNote(replay.uid, onlineLookup, detailTeams)
    : rated ? null : notRatedReason(validity);
  // `Modal` closes on Escape from a bubble-phase listener on the document, so
  // an overlay that wants Escape first has to take it in the capture phase:
  // stopping propagation there means the modal's listener never runs, and one
  // press steps back out of the preview instead of shutting the whole panel.
  useEffect(() => {
    if (!enlarged) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setEnlarged(false);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [enlarged]);

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
  const lineupSummary = competingTeams > 1
    ? t("replays.detail.teamSummary", { teams: competingTeams, players })
    : players;
  const mapLabel = presentation.displayName || effectiveMap;
  const cardTitle = replay.title || mapLabel;
  const stars = replay.reviewsAverage ?? null;
  // Rebuilding a generated map from its seed, which is how a generated map is
  // obtained: there is nothing to download. Its own value rather than only a
  // branch of the thumbnail's action below, because the heatmap wants the
  // same button -- the thumbnail offers nothing once the map is on disk, and
  // the heatmap can still have no picture to draw its cells over.
  const generateAction = isGenerated
    ? {
        icon: isGeneratingThisMap ? "refresh" : "plus",
        label: isGeneratingThisMap
          ? t("lobby.details.generatingMap")
          : !seed && downloadState === "downloading"
            ? t("replays.detail.resolvingMap")
            : t("lobby.details.generateMap"),
        disabled: isGeneratingThisMap || (!seed && downloadState === "downloading"),
        run: () => {
          if (seed) {
            ipc.send({ kind: "MapGenerator", command: { type: "generateNamed", payload: { mapName: effectiveMap } } });
          } else if (replay.replayAvailable) {
            ipc.send({ kind: "Replays", command: { type: "downloadVault", payload: { uid: replay.uid } } });
          }
        },
      }
    : null;
  // The map action the thumbnail overlays: one of them, never both. Which one
  // depends on whether the map is on disk.
  const mapAction = installed
    ? null
    : generateAction
      ?? (vaultMap
        ? {
            icon: "download",
            label: t("lobby.details.downloadMap"),
            disabled: false,
            run: () =>
              ipc.send({
                kind: "Maps",
                command: { type: "installMap", payload: { folderName: vaultMap.folderName, downloadUrl: vaultMap.downloadUrl } },
              }),
          }
        : null);
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
      <div className="replay-card-layout">
        {/* The rail: what this replay *is* and what you can do to the file.
            The main column is what happened in it. */}
        <aside className="replay-card-rail">
          {/* A preview the size of the one in the Play tab's sidebar, and
              nothing more until it is asked for. The zoom widget is a viewport
              plus a row of controls plus a hint line: at rail width that is
              three quarters furniture, and a wheel over it swallowed the
              scroll of the panel behind. Clicking enlarges it, and everything
              the Maps tab offers is there once it is open. */}
          <div className="replay-rail-thumb">
            <button
              type="button"
              className="replay-rail-thumb-open"
              onClick={() => setEnlarged(true)}
              title={t("maps.preview.enlarge", { name: mapLabel })}
              aria-label={t("maps.preview.enlarge", { name: mapLabel })}
            >
              <ReplayMapThumb
                url={replay.mapThumbnailUrl}
                mapName={effectiveMap}
                className="replay-rail-thumb-image"
                emptyClassName="replay-rail-thumb-empty"
                iconSize={44}
                large
              />
              <span className="replay-rail-thumb-zoom" aria-hidden>
                <Icon name="search" size={14} />
              </span>
            </button>
            {mapAction && (
              <div className="replay-rail-thumb-actions">
                <button
                  type="button"
                  className="replay-rail-thumb-btn"
                  disabled={mapAction.disabled}
                  onClick={mapAction.run}
                  title={mapAction.label}
                  aria-label={mapAction.label}
                >
                  <Icon
                    name={mapAction.icon as IconName}
                    size={14}
                    className={isGeneratingThisMap ? "spin" : undefined}
                  />
                </button>
              </div>
            )}
          </div>
          {/* Read-only: FAF carries a replay's score but this client has no way
              to write one back, and a rating control that cannot rate is worse
              than none. */}
          <div className="replay-card-rating">
            <span
              className="replay-card-stars"
              role="img"
              aria-label={stars === null
                ? t("replays.detail.noRatingYet")
                : t("reviews.scoreAria", { score: stars.toFixed(1), of: 5 })}
            >
              {[1, 2, 3, 4, 5].map((step) => (
                <Icon
                  key={step}
                  name="star"
                  size={15}
                  className={stars !== null && stars >= step - 0.5 ? "is-filled" : "is-empty"}
                />
              ))}
            </span>
            <span className="replay-card-rating-value">
              {stars === null ? t("replays.detail.unrated") : formatDecimal(stars)}
              {replay.reviewsCount ? (
                <span className="muted"> · {replay.reviewsCount}</span>
              ) : null}
            </span>
          </div>
          <div className="replay-card-rail-actions">
            {onDownload && (
              <Button
                className="replay-card-rail-btn"
                disabled={!replay.replayAvailable || downloadState === "downloading" || downloadState === "downloaded"}
                onClick={onDownload}
                title={t("replays.detail.download")}
              >
                <span>{t(downloadState === "downloading"
                  ? "replays.detail.downloading"
                  : downloadState === "downloaded"
                    ? "replays.detail.downloaded"
                    : "replays.detail.downloadReplay")}</span>
                <Icon name="download" size={15} />
              </Button>
            )}
            {/* The shortest path from "that game went badly" to a request
                someone can answer. The client already knows the replay, the
                map, the mode and this account's rating in it, so the training
                tab's form opens with only the question left to write.

                Naming the replay rather than passing the details is
                deliberate: the training service reads them back out of state,
                so this button cannot prefill the form with anything the
                client does not actually know. */}
            <Button
              className="replay-card-rail-btn"
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
              <span>{t("replays.detail.requestReviewShort")}</span>
              <Icon name="book" size={15} />
            </Button>
            {onToggleWatched && (
              <Button
                className={watched ? "replay-card-rail-btn is-on" : "replay-card-rail-btn"}
                aria-pressed={watched}
                onClick={onToggleWatched}
                title={t(watched ? "replays.watched.unmark" : "replays.watched.mark")}
              >
                <span>{t(watched ? "replays.watched.unmark" : "replays.watched.mark")}</span>
                <Icon name={watched ? "check" : "eye"} size={15} />
              </Button>
            )}
            <Button
              className="replay-card-rail-btn"
              onClick={() => {
                // Both reads, in the order they are wanted. The file is
                // fetched once and the second walk reads it off disk, so the
                // expensive half costs the reader nothing until they reach a
                // tab that needs it.
                if (!details && !isLoadingDetails) loadDetails();
                if (!analysis && analysisLoading !== replay.uid) loadAnalysis();
                setShowInsights(true);
              }}
              aria-haspopup="dialog"
              aria-expanded={showInsights}
              title={t("replays.insights.openHint")}
            >
              <span>{t(isLoadingDetails ? "replays.detail.loadingDetails" : "replays.detail.loadDetails")}</span>
              <Icon name={isLoadingDetails ? "refresh" : "list"} size={15} className={isLoadingDetails ? "spin" : undefined} />
            </Button>
          </div>
        </aside>

        <div className="replay-card-main">
          <div className="replay-card-heading">
            <h2 className="replay-card-title" title={cardTitle}>{cardTitle}</h2>
            <p className="replay-card-onmap">{t("replays.detail.onMap", { map: mapLabel })}</p>
            {/* Directly under the map it belongs to. A generated map has no
                name worth reading -- the line above says only that a generator
                made it -- so the seed is the one thing there that identifies
                the map, and it is what somebody rebuilding it copies. */}
            {seed && (
              <div className="replay-card-seed">
                <span className="replay-card-seed-label">{t("replays.detail.mapSeed")}</span>
                <code className="replay-fact-seed-code" title={seed}>{seed}</code>
                <button
                  type="button"
                  className="replay-card-icon-btn"
                  aria-label={t(copiedSeed ? "replays.detail.seedCopied" : "replays.detail.copySeed")}
                  title={t(copiedSeed ? "replays.detail.seedCopied" : "replays.detail.copySeed")}
                  onClick={() =>
                    ipc.run(navigator.clipboard.writeText(seed).then(() => setCopiedSeed(true)))
                  }
                >
                  <Icon name={copiedSeed ? "check" : "copy"} size={13} />
                </button>
              </div>
            )}
          </div>
          {/* No age badge. `formatAgeOrDate` prints the date itself once "how
              long ago" has stopped reading as a length of time, so on every
              replay older than a week this line was the Date tile below it,
              written a second time directly above it. The date is a fact and
              belongs in the tiles with the other facts; the replay id, which
              was off in the rail, takes the first of them. */}
          {!replay.replayAvailable && (
            <div className="replay-card-badges">
              <span className="replay-availability pending">{t("replays.detail.processing")}</span>
            </div>
          )}
          {/* Java's detail view keeps the eight core facts in two balanced
              rows. Same eight, four columns wide so the pair of durations that
              are routinely minutes apart sit side by side, and each one its
              own tile: value first, caption under it, glyph beside both. The
              replay id takes the first two of the top row, which still
              leaves the eight falling four to a row and that pairing
              intact. */}
          <dl className="replay-card-facts">
            {/* The id first, and the two things you do with one beside it:
                copy the number, copy the link. It is the label that says
                which replay this is, which is a fact about the game and not
                an action on the file, so it sits with the facts. */}
            <div className="replay-card-fact-id">
              <dt><Icon name="list" size={14} />{t("replays.detail.replayIdLabel")}</dt>
              <dd>
                {replay.uid > 0 ? (
                  <>
                    <span className="replay-card-idvalue">#{replay.uid}</span>
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
                  <span className="muted">{t("replays.local.noReplayId")}</span>
                )}
              </dd>
            </div>
            <div><dt><Icon name="calendar" size={14} />{t("replays.detail.date")}</dt><dd>{formatDate(replay.startTime, t("replays.detail.unknown"))}</dd></div>
            <div><dt><Icon name="users" size={14} />{t("replays.detail.players")}</dt><dd>{totalPlayers}</dd></div>
            <div><dt><Icon name="leaderboard" size={14} />{t("replays.detail.avgRating")}</dt><dd>{replay.averageRating !== null ? replay.averageRating : t("replays.detail.unrated")}</dd></div>
            <div><dt><Icon name="hourglass" size={14} />{t("replays.detail.gameTime")}</dt><dd>{replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : t("replays.detail.unknown")}</dd></div>
            <div><dt><Icon name="clock" size={14} />{t("replays.detail.time")}</dt><dd>{formatTime(replay.startTime, t("replays.detail.unknown"))}</dd></div>
            <div><dt><Icon name="settings" size={14} />{t("replays.detail.featuredMod")}</dt><dd>{replay.modName || t("replays.detail.unknown")}</dd></div>
            <div><dt><Icon name="activity" size={14} />{t("replays.detail.quality")}</dt><dd>{replay.quality !== null ? `${replay.quality}%` : t("replays.detail.unknown")}</dd></div>
            <div><dt><Icon name="play" size={14} />{t("replays.detail.realTime")}</dt><dd>{replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : t("replays.detail.unknown")}</dd></div>
          </dl>
          {/* Named by its summary rather than by a heading: the team
              panels carry their own headings, and a third one above them
              read as a section title for a section that is all there is. */}
          <section className="replay-card-lineup" aria-label={lineupSummary}>
            {detailTeams.length > 0 ? (
              <ReplayDetailRoster
                teams={detailTeams}
                showResults={showResults}
                avatarByLogin={avatarByLogin}
              />
            ) : (
              <p className="replay-detail-empty muted">{t("replays.detail.noLineup")}</p>
            )}
          </section>
          <div className="replay-card-bottom">
            {/* Why the button is dead, directly above the button.

                This sentence used to sit above the lineup, where a reader who
                had just clicked a greyed-out control at the bottom of the
                panel never connected the two: the report was "I clicked game
                result and wondered why it does not work". A disabled control
                owes its reason to the place the click landed. Above rather
                than beside: a reason long enough to be one pushed the button
                sideways and left the pair reading as two half-width controls. */}
            <span className="replay-card-result-group">
              {!rated && (
                <span className="replay-card-result-reason" id="replay-result-reason">
                  <Icon name="info" size={13} />
                  <span>{notRated ?? t("replays.detail.noResultYet")}</span>
                </span>
              )}
              <Button
                className="replay-card-result-btn"
                aria-pressed={showResults}
                disabled={!rated}
                aria-describedby={rated ? undefined : "replay-result-reason"}
                onClick={() => setShowResults((visible) => !visible)}
              >
                <Icon name="eye" size={15} />
                <span>{t(showResults ? "replays.detail.hideResults" : "replays.detail.gameResult")}</span>
              </Button>
            </span>
            <Button
              className="replay-card-watch-btn"
              variant="primary"
              disabled={busy || !replay.replayAvailable}
              onClick={onWatch}
            >
              <Icon name="play" size={15} />
              <span>{t(replay.replayAvailable ? "replays.detail.watch" : "replays.detail.notUploaded")}</span>
            </Button>
          </div>
        </div>
      </div>
      {/* The enlarged preview, in this dialog's own markup rather than in a
          second `Modal`: `Modal` closes on Escape from a document listener, so
          two stacked would close both at once. It covers the viewport the way
          a dialog would, and leaves the same three ways out -- the button, the
          scrim, and Escape. */}
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
                too, and it is the one thing a replay carries that nothing else
                on this card spells out in full. */}
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
                    onClick={() =>
                      ipc.run(navigator.clipboard.writeText(effectiveMap).then(() => setCopiedMapName(true)))
                    }
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
                emptyClassName="replay-rail-thumb-empty"
                iconSize={64}
                large
              />
            </MapPreviewFrame>
          </div>
        </div>
      )}
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
                style={{ width: `${generatorProgress.percent}%` }}
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

      {/* The tabbed panel the button above opens. It opens on the click, not
          on the answer: the file may still have to be downloaded, and a
          disabled button with nothing happening behind it is what the thread
          was about. */}
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
        <p className="replay-download-error surface-error" style={{ marginTop: "12px" }}>
          {detailsError}
        </p>
      )}
    </Modal>
  );
}
