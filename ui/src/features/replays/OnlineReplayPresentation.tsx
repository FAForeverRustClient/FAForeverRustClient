import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { ReplayTeam, VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatDate, formatDateTime, formatShortDate } from "../../shared/dates";
import { formatDuration, formatRelativeDuration } from "../../shared/durations";
import { baseMapName, normalizeMapName } from "../../shared/mapPresentation";
import { onlineReplayLink } from "../../shared/replayLinks";
import {
  isObserverTeam,
  outcomeLabel,
  playerCount,
  ReplayCardRoster,
  ReplayDetailRoster,
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
  const normalized = mapName ? normalizeMapName(mapName) : "";
  const baseName = mapName ? baseMapName(mapName) : "";
  const size = large ? "large" : "small";
  const cdnFallback = normalized && !normalized.includes(" ")
    ? `https://content.faforever.com/maps/previews/${size}/${encodeURIComponent(normalized)}.png`
    : undefined;
  const baseFallback = baseName && baseName !== normalized && !baseName.includes(" ")
    ? `https://content.faforever.com/maps/previews/${size}/${encodeURIComponent(baseName)}.png`
    : undefined;

  const [currentUrl, setCurrentUrl] = useState(url || cdnFallback || baseFallback || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCurrentUrl(url || cdnFallback || baseFallback || null);
    setFailed(false);
  }, [url, cdnFallback, baseFallback]);

  const handleError = () => {
    if (currentUrl === url && cdnFallback && currentUrl !== cdnFallback) {
      setCurrentUrl(cdnFallback);
    } else if (
      (currentUrl === url || currentUrl === cdnFallback) &&
      baseFallback &&
      currentUrl !== baseFallback
    ) {
      setCurrentUrl(baseFallback);
    } else {
      setFailed(true);
    }
  };

  if (!currentUrl || failed) {
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
      onError={handleError}
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
  const cardTitle = replayCardTitle(replay.title, replay.map);
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
          <span className="replay-card-submap muted">{t("replays.card.onMap", { map: replay.map })}</span>
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
  return (
    <ReplayLibraryCard
      replay={{
        idLabel: `#${replay.uid}`,
        title: replay.title,
        map: replay.map,
        mapThumbnailUrl: replay.mapThumbnailUrl,
        modName: replay.modName,
        startTime: replay.startTime,
        teams: replay.teams,
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
  const groups = groupByDate
    ? groupReplaysByDate(replays)
    : [{ label: t("replays.list.results"), replays }];

  const listGroups: ReplayListGroup[] = groups.map((group) => ({
    label: group.label,
    rows: group.replays.map((replay) => ({
      key: String(replay.uid),
      mapName: replay.map,
      mapThumbnailUrl: replay.mapThumbnailUrl,
      game: {
        primary: replay.title || replay.map,
        secondary: replay.map || t("replays.list.mapUnavailable"),
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
    })),
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

export function ReplayDetailPanel({
  replay,
  busy,
  onClose,
  onWatch,
  onDownload,
  downloadState,
  downloadError,
}: {
  replay: VaultReplay;
  busy: boolean;
  onClose: () => void;
  onWatch: () => void;
  onDownload: () => void;
  downloadState: "idle" | "downloading" | "downloaded" | "failed";
  downloadError: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const totalPlayers = playerCount(replay.teams);
  const hasResults = replay.teams.some((team) =>
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
  const competingTeams = replay.teams.filter((team) => !isObserverTeam(team.team)).length;
  const players = t("replays.detail.playerCount", { count: totalPlayers });
  const lineupSummary = competingTeams > 1
    ? t("replays.detail.teamSummary", { teams: competingTeams, players })
    : players;
  return (
    <Modal className="replay-detail-modal" ariaLabel={t("replays.detail.aria", { name: replay.title || replay.map })} onClose={onClose}>
      <header className="replay-detail-head">
        <ReplayMapThumb
          url={replay.mapThumbnailUrl}
          mapName={replay.map}
          className="replay-detail-thumb"
          emptyClassName="replay-detail-thumb-empty"
          iconSize={40}
          large
        />
        <div className="replay-detail-headtext">
          <div className="replay-detail-eyebrow">
            <span>{t("replays.detail.eyebrow", { uid: replay.uid })}{age && <> · {age}</>}</span>
            <Button
              className="replay-copy-id-button"
              aria-label={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
              title={t(copiedId ? "replays.detail.idCopied" : "replays.detail.copyId")}
              onClick={copyReplayId}
            >
              {t(copiedId ? "replays.detail.copiedShort" : "replays.detail.copyIdShort")}
            </Button>
          </div>
          <h2>{replay.title || replay.map}</h2>
          <p className="replay-detail-map"><Icon name="maps" size={15} /> {replay.map}</p>
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
        {/* Watch leads; the two file actions sit under it as a secondary pair
            so three same-width buttons no longer read as a menu. */}
        <div className="replay-detail-actions">
          <Button
            className="replay-watch-button"
            variant="primary"
            disabled={busy || !replay.replayAvailable}
            onClick={onWatch}
          >
            <Icon name="play" size={15} /> {t(replay.replayAvailable ? "replays.detail.watch" : "replays.detail.notUploaded")}
          </Button>
          <div className="replay-detail-actions-secondary">
            <Button
              disabled={!replay.replayAvailable || downloadState === "downloading"}
              onClick={onDownload}
            >
              {t(downloadState === "downloading"
                ? "replays.detail.downloading"
                : downloadState === "downloaded"
                  ? "replays.detail.downloaded"
                  : "replays.detail.download")}
            </Button>
            <Button onClick={copyLink}>{t(copied ? "replays.detail.copiedShort" : "replays.detail.copyLink")}</Button>
          </div>
        </div>
      </header>
      {downloadState === "failed" && (
        <p className="replay-download-error surface-error">{t("replays.detail.downloadFailed", { error: downloadError })}</p>
      )}

      {/* One dense row of facts instead of a six-cell boxed grid: the values are
          all short, and the grid spent ~120px of modal height saying very
          little. Mirrors the icon meta row in the Java client's detail view. */}
      <dl className="replay-detail-facts">
        <div><dt>{t("replays.detail.played")}</dt><dd>{formatDateTime(replay.startTime, t("replays.detail.unknown"))}</dd></div>
        <div><dt>{t("replays.detail.gameTime")}</dt><dd>{replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.realTime")}</dt><dd>{replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : t("replays.detail.unknown")}</dd></div>
        <div><dt>{t("replays.detail.players")}</dt><dd>{totalPlayers}</dd></div>
        <div><dt>{t("replays.detail.avgRating")}</dt><dd>{replay.averageRating !== null ? replay.averageRating : t("replays.detail.unrated")}</dd></div>
        <div><dt>{t("replays.detail.featuredMod")}</dt><dd>{replay.modName || t("replays.detail.unknown")}</dd></div>
      </dl>

      <section className="replay-detail-lineup">
        <div className="replay-detail-section-head">
          <div>
            <span className="replay-detail-eyebrow">{t("replays.detail.lineup")}</span>
            <h3>{lineupSummary}</h3>
          </div>
          {hasResults && (
            <Button aria-pressed={showResults} onClick={() => setShowResults((visible) => !visible)}>
              {t(showResults ? "replays.detail.hideResults" : "replays.detail.revealResults")}
            </Button>
          )}
        </div>
        {replay.teams.length > 0 ? (
          <ReplayDetailRoster teams={replay.teams} showResults={showResults} />
        ) : (
          <p className="replay-detail-empty muted">{t("replays.detail.noLineup")}</p>
        )}
      </section>
    </Modal>
  );
}
