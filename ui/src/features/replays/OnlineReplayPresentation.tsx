import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type {
  LocalReplay,
  LocalReplayPlayer,
  LocalReplayTeam,
  ReplayTeam,
  VaultMap,
  VaultReplay,
} from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatDate, formatShortDate, formatTime } from "../../shared/dates";
import { formatDuration, formatRelativeDuration } from "../../shared/durations";
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
import { onlineReplayLink } from "../../shared/replayLinks";
import { useAppStore } from "../../store/store";
import {
  isObserverTeam,
  outcomeLabel,
  playerCount,
  ReplayCardRoster,
  ReplayDetailRoster,
  mergeReplayTeamsWithLocal,
} from "./ReplayRoster";
import {
  formatReplayListTime,
  ReplayList,
  type ReplayListGroup,
} from "./ReplayList";
import { t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

/** "3d ago" beside the replay id, so recency reads without parsing a date. */
function replayAge(startTime: string): string {
  if (!startTime) return "";
  const played = new Date(startTime).getTime();
  if (Number.isNaN(played)) return "";
  const seconds = (Date.now() - played) / 1000;
  if (seconds < 0) return "";
  const justNow = t("replays.card.justNow");
  const elapsed = formatRelativeDuration(seconds, { nowLabel: justNow });
  // The whole phrase is one message: German fronts the preposition ("vor 3d"),
  // which a suffix appended to the duration could not produce.
  return elapsed === justNow ? elapsed : t("replays.card.ago", { duration: elapsed });
}

export interface ReplayCardData {
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

const REPLAY_CARD_TITLE_LIMIT = 48;

function replayCardTitle(title: string, fallback: string): { full: string; display: string } {
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
function ReplayMetaFact({ icon, label, value }: { icon: IconName; label: string; value: string }) {
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

function ReplayMapThumb({
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
  const candidates = useMemo(
    () => mapThumbnailCandidates(vault, mapName, large, undefined, generatedPreview, url || undefined),
    [generatedPreview, large, mapName, url, vault],
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
  onOpen,
  onDoubleClick,
}: {
  replay: ReplayCardData;
  watched: boolean;
  selected?: boolean;
  onOpen: () => void;
  onDoubleClick?: () => void;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const presentation = mapPresentation(vault, replay.map);
  const cardTitle = replayCardTitle(replay.title, presentation.displayName || replay.map);
  const stateClasses = [watched && "replay-card-watched", selected && "replay-card-selected"]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      className={`replay-card surface-panel surface-interactive ${stateClasses}`.trim()}
      aria-pressed={selected || undefined}
      onClick={onOpen}
      onDoubleClick={onDoubleClick}
    >
      <div className="replay-card-left">
        <ReplayMapThumb
          url={replay.mapThumbnailUrl}
          mapName={replay.map}
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
        <div className="replay-card-footer muted">
          {replay.footerNote && <span>{replay.footerNote} · </span>}
          <span>{replay.idLabel}</span>
        </div>
      </div>
    </button>
  );
}

export function ReplayCard({
  replay,
  watched,
  onOpen,
  onDoubleClick,
}: {
  replay: VaultReplay;
  watched: boolean;
  onOpen: () => void;
  onDoubleClick?: () => void;
}) {
  const { t } = useTranslation();
  const localReplays = useAppStore((state) => state.state.replays.local);
  const localMatch = localReplays.find((local) => local.uid === replay.uid);
  const map = effectiveReplayMapName(replay.map, localMatch?.map);
  return (
    <ReplayLibraryCard
      replay={{
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
}: {
  replays: VaultReplay[];
  groupByDate?: boolean;
  selectedUid: number | null;
  watchedUids: Set<number>;
  onSelect: (uid: number) => void;
  onOpen: (uid: number) => void;
  onWatch?: (uid: number) => void;
}) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const localReplays = useAppStore((state) => state.state.replays.local);
  const groups = groupByDate
    ? groupReplaysByDate(replays)
    : [{ label: t("replays.list.results"), replays }];

  const listGroups: ReplayListGroup[] = groups.map((group) => ({
    label: group.label,
    rows: group.replays.map((replay) => {
      const map = effectiveReplayMapName(replay.map, localReplays.find((local) => local.uid === replay.uid)?.map);
      const presentation = mapPresentation(vault, map);
      return {
        key: String(replay.uid),
        mapName: map,
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

function formatChatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function localReplayToVaultReplay(local: LocalReplay, mapVault: VaultMap[]): VaultReplay {
  const presentation = local.map ? mapPresentation(mapVault, local.map) : null;
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
}: {
  replay: VaultReplay;
  busy: boolean;
  onClose: () => void;
  onWatch: () => void;
  onDownload?: () => void;
  downloadState?: "idle" | "downloading" | "downloaded" | "failed";
  downloadError?: string;
  localPath?: string;
}) {
  const { t } = useTranslation();
  const maps = useAppStore((state) => state.state.maps);
  const socialPlayers = useAppStore((state) => state.state.social.players);
  const localReplays = useAppStore((state) => state.state.replays.local);
  const mapGenStatus = useAppStore((state) => state.state.mapGenerator.status);
  const replayDetails = useAppStore((state) => state.state.replays.replayDetails);
  const detailsLoading = useAppStore((state) => state.state.replays.detailsLoading);
  const detailsError = useAppStore((state) => state.state.replays.detailsError);
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
  const detailTeams = mergeReplayTeamsWithLocal(replay.teams, localMatch?.teams);
  const localPath = initialLocalPath || localMatch?.path;
  const details = replay.uid ? replayDetails?.[replay.uid] : undefined;
  const isLoadingDetails = detailsLoading === replay.uid;
  const [optionFilter, setOptionFilter] = useState("");

  const filteredOptions = useMemo(() => {
    if (!details?.gameOptions) return [];
    if (!optionFilter.trim()) return details.gameOptions;
    const query = optionFilter.toLowerCase();
    return details.gameOptions.filter(
      (option) => option.key.toLowerCase().includes(query) || option.value.toLowerCase().includes(query),
    );
  }, [details?.gameOptions, optionFilter]);

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

  const effectiveMap = effectiveReplayMapName(replay.map, localMatch?.map);
  const isGenerated = isGeneratedMap(effectiveMap);
  const seed = extractGeneratedMapSeed(effectiveMap);

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
  const presentation = mapPresentation(maps.vault, effectiveMap);

  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedSeed, setCopiedSeed] = useState(false);
  const [showResults, setShowResults] = useState(false);

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
  const hasResults = detailTeams.some((team) =>
    team.players.some((player) => Boolean(outcomeLabel(player.outcome))),
  );
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
  const age = replayAge(replay.startTime);
  const competingTeams = detailTeams.filter((team) => !isObserverTeam(team.team)).length;
  const players = t("replays.detail.playerCount", { count: totalPlayers });
  const lineupSummary = competingTeams > 1
    ? t("replays.detail.teamSummary", { teams: competingTeams, players })
    : players;
  return (
    <Modal className="replay-detail-modal" ariaLabel={t("replays.detail.aria", { name: replay.title || presentation.displayName || effectiveMap })} onClose={onClose}>
      <header className="replay-detail-head">
        <ReplayMapThumb
          url={replay.mapThumbnailUrl}
          mapName={effectiveMap}
          className="replay-detail-thumb"
          emptyClassName="replay-detail-thumb-empty"
          iconSize={40}
          large
        />
        <div className="replay-detail-headtext">
          <div className="replay-detail-eyebrow">
            <span>
              {replay.uid > 0
                ? t("replays.detail.eyebrow", { uid: replay.uid })
                : t("replays.local.noReplayId")}
              {age && <> · {age}</>}
            </span>
            {replay.uid > 0 && (
              <Button
                className="replay-copy-id-button"
                aria-label={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
                title={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
                onClick={copyReplayId}
              >
                {t(copiedId ? "replays.detail.copiedShort" : "replays.detail.copyIdShort")}
              </Button>
            )}
          </div>
          <h2>{replay.title || presentation.displayName || effectiveMap}</h2>
          <p className="replay-detail-map"><Icon name="maps" size={15} /> <span>{presentation.displayName || effectiveMap}</span></p>
          {seed && (
            <div className="replay-detail-seed">
              <span className="replay-seed-label">{t("replays.detail.mapSeed")}:</span>
              <code className="replay-fact-seed-code" title={seed}>{seed}</code>
              <button
                type="button"
                className="replay-fact-copy-seed-btn"
                aria-label={t(copiedSeed ? "replays.detail.seedCopied" : "replays.detail.copySeed")}
                title={t(copiedSeed ? "replays.detail.seedCopied" : "replays.detail.copySeed")}
                onClick={() =>
                  ipc.run(
                    navigator.clipboard
                      .writeText(seed)
                      .then(() => setCopiedSeed(true)),
                  )
                }
              >
                <Icon name={copiedSeed ? "check" : "copy"} size={12} />
              </button>
            </div>
          )}
          <div className="replay-detail-badges">
            <span className={replay.replayAvailable ? "replay-availability ready" : "replay-availability pending"}>
              {t(replay.replayAvailable ? "replays.detail.available" : "replays.detail.processing")}
            </span>
            {replay.reviewsCount ? (
              <span className="replay-availability neutral" title={t("replays.detail.reviewCount", { count: replay.reviewsCount })}>
                ★ {replay.reviewsAverage?.toFixed(1) ?? "N/A"} · {replay.reviewsCount}
              </span>
            ) : null}
          </div>
        </div>
        {/* Watch leads; the file actions sit under it as a compact secondary pair. */}
        <div className="replay-detail-actions">
          <Button
            className="replay-watch-button"
            variant="primary"
            disabled={busy || !replay.replayAvailable}
            onClick={onWatch}
          >
            <Icon name="play" size={15} /> {t(replay.replayAvailable ? "replays.detail.watch" : "replays.detail.notUploaded")}
          </Button>
          {!installed && isGenerated && (
            <Button
              disabled={isGeneratingThisMap || (!seed && downloadState === "downloading")}
              onClick={() => {
                if (seed) {
                  ipc.send({
                    kind: "MapGenerator",
                    command: {
                      type: "generateNamed",
                      payload: {
                        mapName: effectiveMap,
                      },
                    },
                  });
                } else if (replay.replayAvailable) {
                  ipc.send({
                    kind: "Replays",
                    command: {
                      type: "downloadVault",
                      payload: { uid: replay.uid },
                    },
                  });
                }
              }}
            >
              {isGeneratingThisMap ? (
                <Icon name="refresh" size={13} className="spin" />
              ) : (
                <Icon name="plus" size={13} />
              )}
              {isGeneratingThisMap
                ? t("lobby.details.generatingMap")
                : !seed && downloadState === "downloading"
                  ? t("replays.detail.resolvingMap")
                  : t("lobby.details.generateMap")}
            </Button>
          )}
          {!installed && !isGenerated && vaultMap && (
            <Button
              onClick={() =>
                ipc.send({
                  kind: "Maps",
                  command: {
                    type: "installMap",
                    payload: {
                      folderName: vaultMap.folderName,
                      downloadUrl: vaultMap.downloadUrl,
                    },
                  },
                })
              }
            >
              <Icon name="plus" size={13} />
              {t("lobby.details.downloadMap")}
            </Button>
          )}
          <div className="replay-detail-actions-secondary">
            {onDownload && (
              <Button
                className="replay-secondary-btn replay-download-button"
                disabled={!replay.replayAvailable || downloadState === "downloading" || downloadState === "downloaded"}
                onClick={onDownload}
                title={t("replays.detail.download")}
              >
                <Icon name="download" size={13} />
                <span>{t(downloadState === "downloading"
                  ? "replays.detail.downloading"
                  : downloadState === "downloaded"
                    ? "replays.detail.downloaded"
                    : "replays.detail.downloadShort")}</span>
              </Button>
            )}
            {replay.uid > 0 && (
              <Button
                className="replay-secondary-btn"
                onClick={copyLink}
                title={t("replays.detail.copyLink")}
              >
                <Icon name={copied ? "check" : "copy"} size={13} />
                <span>{t(copied ? "replays.detail.copiedShort" : "replays.detail.copyLink")}</span>
              </Button>
            )}
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

      {/* Java's detail view keeps the eight core facts in two balanced rows. */}
      <dl className="replay-detail-facts">
        <div><dt>{t("replays.detail.date")}</dt><dd>{formatDate(replay.startTime, t("replays.detail.unknown"))}</dd></div>
        <div><dt>{t("replays.detail.time")}</dt><dd>{formatTime(replay.startTime, t("replays.detail.unknown"))}</dd></div>
        <div><dt>{t("replays.detail.realTime")}</dt><dd>{replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.quality")}</dt><dd>{replay.quality !== null ? `${replay.quality}%` : t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.featuredMod")}</dt><dd>{replay.modName || t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.players")}</dt><dd>{totalPlayers}</dd></div>
        <div><dt>{t("replays.detail.gameTime")}</dt><dd>{replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.avgRating")}</dt><dd>{replay.averageRating !== null ? replay.averageRating : t("replays.detail.unrated")}</dd></div>
      </dl>
      <section className="replay-detail-lineup">
        <div className="replay-detail-section-head">
          <div>
            <h3>{lineupSummary}</h3>
          </div>
          {hasResults && (
            <Button
              className="replay-detail-reveal-btn"
              aria-pressed={showResults}
              onClick={() => setShowResults((visible) => !visible)}
            >
              {t(showResults ? "replays.detail.hideResults" : "replays.detail.revealResults")}
            </Button>
          )}
        </div>
        {detailTeams.length > 0 ? (
          <ReplayDetailRoster teams={detailTeams} showResults={showResults} avatarByLogin={avatarByLogin} />
        ) : (
          <p className="replay-detail-empty muted">{t("replays.detail.noLineup")}</p>
        )}
      </section>

      {!details && (
        <div className="replay-detail-more-info-trigger">
          <Button
            disabled={isLoadingDetails}
            onClick={loadDetails}
            title={t("replays.detail.loadDetails")}
          >
            {isLoadingDetails ? (
              <Icon name="refresh" size={14} className="spin" />
            ) : (
              <Icon name="list" size={14} />
            )}
            <span>{t(isLoadingDetails ? "replays.detail.loadingDetails" : "replays.detail.loadDetails")}</span>
          </Button>
        </div>
      )}

      {details && (
        <>
          <section className="replay-detail-more-info">
            <div className="replay-more-info-grid">
              <div className="replay-more-info-col">
                <div className="replay-more-info-header">
                  <h3 className="replay-more-info-title">{t("replays.detail.gameOptions")}</h3>
                  <input
                    type="search"
                    className="vault-input replay-options-filter"
                    placeholder={t("replays.detail.filterOptions")}
                    value={optionFilter}
                    onChange={(event) => setOptionFilter(event.target.value)}
                  />
                </div>
                <div className="replay-table-scroll">
                  <table className="replay-data-table replay-options-table">
                    <thead>
                      <tr>
                        <th>{t("replays.detail.optionName")}</th>
                        <th>{t("replays.detail.optionValue")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOptions.length > 0 ? (
                        filteredOptions.map((option) => (
                          <tr key={option.key}>
                            <td><strong>{option.key}</strong></td>
                            <td>{option.value}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={2} className="replay-table-empty muted">
                            {t("replays.detail.noOptionsMatch")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="replay-more-info-col">
                <div className="replay-more-info-header">
                  <h3 className="replay-more-info-title">
                    {t("replays.detail.chat")}
                    {details.chatMessages.length > 0 && (
                      <span className="muted replay-more-info-count">
                        ({details.chatMessages.length})
                      </span>
                    )}
                  </h3>
                </div>
                <div className="replay-table-scroll">
                  <table className="replay-data-table">
                    <thead>
                      <tr>
                        <th>{t("replays.detail.chatTime")}</th>
                        <th>{t("replays.detail.chatSender")}</th>
                        <th>{t("replays.detail.chatMessage")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {details.chatMessages.length > 0 ? (
                        details.chatMessages.map((message, index) => (
                          <tr key={`${message.timeSeconds}-${message.sender}-${index}`}>
                            <td className="replay-chat-time">{formatChatTime(message.timeSeconds)}</td>
                            <td className="replay-chat-sender" title={message.sender}>{message.sender}</td>
                            <td className="replay-chat-message">{message.message}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={3} className="replay-table-empty muted">
                            {t("replays.detail.noChat")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
      {detailsError && (
        <p className="replay-download-error surface-error" style={{ marginTop: "12px" }}>
          {detailsError}
        </p>
      )}
    </Modal>
  );
}
