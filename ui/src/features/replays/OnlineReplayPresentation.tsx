import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { ReplayTeam, VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatDate, formatDateTime, formatShortDate } from "../../shared/dates";
import { formatDuration, formatRelativeDuration } from "../../shared/durations";
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

/** "3d ago" beside the replay id, so recency reads without parsing a date. */
function replayAge(startTime: string): string {
  if (!startTime) return "";
  const played = new Date(startTime).getTime();
  if (Number.isNaN(played)) return "";
  const seconds = (Date.now() - played) / 1000;
  if (seconds < 0) return "";
  return formatRelativeDuration(seconds, { nowLabel: "just now", suffix: " ago" });
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
  return (
    <div className="replay-meta-grid muted">
      <ReplayMetaFact icon="calendar" label="Played" value={formatDate(replay.startTime, "")} />
      <ReplayMetaFact icon="users" label="Players" value={`${playerCount(replay.teams)}`} />
      <ReplayMetaFact icon="mods" label="Featured mod" value={replay.modName} />
      <ReplayMetaFact
        icon="activity"
        label="Average rating"
        value={replay.averageRating !== null ? `~${replay.averageRating}` : ""}
      />
      {/* The two durations are routinely minutes apart, so each carries its own
          glyph rather than a trailing "game"/"real" word: the pairing the Java
          card uses (`game-duration-icon` / `world-duration-icon`). */}
      <ReplayMetaFact
        icon="hourglass"
        label="Game time (simulation)"
        value={replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : ""}
      />
      <ReplayMetaFact
        icon="clock"
        label="Real time (wall clock)"
        value={replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : ""}
      />
    </div>
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
        {replay.mapThumbnailUrl ? (
          <img className="replay-card-thumb" src={replay.mapThumbnailUrl} alt={replay.map} />
        ) : (
          <div className="replay-card-thumb" />
        )}
        <ReplayStars replay={replay} />
        <ReplayMetaGrid replay={replay} />
      </div>
      <div className="replay-card-right">
        <div className="replay-card-header">
          <span className="replay-card-title" title={cardTitle.full} aria-label={cardTitle.full}>{cardTitle.display}</span>
          <span className="replay-card-submap muted">on {replay.map}</span>
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
        footerNote: replay.replayAvailable ? "" : "not uploaded yet",
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
  const groups = groupByDate
    ? groupReplaysByDate(replays)
    : [{ label: "Results", replays }];

  const listGroups: ReplayListGroup[] = groups.map((group) => ({
    label: group.label,
    rows: group.replays.map((replay) => ({
      key: String(replay.uid),
      mapName: replay.map,
      mapThumbnailUrl: replay.mapThumbnailUrl,
      game: {
        primary: replay.title || replay.map,
        secondary: replay.map || "Map unavailable",
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
        secondary: replay.durationSeconds !== null ? `${formatDuration(replay.durationSeconds)} real` : "Real time N/A",
      },
      replay: {
        primary: replay.replayAvailable ? "Available" : "Processing",
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
        label: "Details",
        ariaLabel: `Open replay ${replay.uid} details`,
        onClick: () => onOpen(replay.uid),
      },
    })),
  }));

  return (
    <ReplayList
      groups={listGroups}
      footer={<><span>{replays.length} {replays.length === 1 ? "replay" : "replays"}</span><span>Select a row to highlight it · double-click to watch replay</span></>}
    />
  );
}

function groupReplaysByDate(replays: VaultReplay[]): Array<{ label: string; replays: VaultReplay[] }> {
  const groups: Array<{ label: string; replays: VaultReplay[] }> = [];
  for (const replay of replays) {
    const label = formatShortDate(replay.startTime, "Unknown date");
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
  const lineupSummary = competingTeams > 1
    ? `${competingTeams} teams · ${totalPlayers} ${totalPlayers === 1 ? "player" : "players"}`
    : `${totalPlayers} ${totalPlayers === 1 ? "player" : "players"}`;
  return (
    <Modal className="replay-detail-modal" ariaLabel={`Replay ${replay.title || replay.map}`} onClose={onClose}>
      <header className="replay-detail-head">
        {replay.mapThumbnailUrl ? (
          <img className="replay-detail-thumb" src={replay.mapThumbnailUrl} alt={replay.map} />
        ) : (
          <div className="replay-detail-thumb replay-detail-thumb-empty"><Icon name="maps" size={34} /></div>
        )}
        <div className="replay-detail-headtext">
          <div className="replay-detail-eyebrow">
            <span>Replay #{replay.uid}{age && <> · {age}</>}</span>
            <Button
              className="replay-copy-id-button"
              aria-label={copiedId ? "Replay ID copied" : "Copy replay ID"}
              title={copiedId ? "Replay ID copied" : "Copy replay ID"}
              onClick={copyReplayId}
            >
              {copiedId ? "Copied" : "Copy ID"}
            </Button>
          </div>
          <h2>{replay.title || replay.map}</h2>
          <p className="replay-detail-map"><Icon name="maps" size={15} /> {replay.map}</p>
          <div className="replay-detail-badges">
            <span className={replay.replayAvailable ? "replay-availability ready" : "replay-availability pending"}>
              {replay.replayAvailable ? "Replay available" : "Processing upload"}
            </span>
            {replay.reviewsCount ? (
              <span className="replay-availability neutral" title={`${replay.reviewsCount} community ${replay.reviewsCount === 1 ? "review" : "reviews"}`}>
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
            <Icon name="play" size={15} /> {replay.replayAvailable ? "Watch" : "Not uploaded"}
          </Button>
          <div className="replay-detail-actions-secondary">
            <Button
              disabled={!replay.replayAvailable || downloadState === "downloading"}
              onClick={onDownload}
            >
              {downloadState === "downloading"
                ? "Downloading…"
                : downloadState === "downloaded"
                  ? "Downloaded"
                  : "Download"}
            </Button>
            <Button onClick={copyLink}>{copied ? "Copied" : "Copy link"}</Button>
          </div>
        </div>
      </header>
      {downloadState === "failed" && (
        <p className="replay-download-error surface-error">Could not download replay: {downloadError}</p>
      )}

      {/* One dense row of facts instead of a six-cell boxed grid: the values are
          all short, and the grid spent ~120px of modal height saying very
          little. Mirrors the icon meta row in the Java client's detail view. */}
      <dl className="replay-detail-facts">
        <div><dt>Played</dt><dd>{formatDateTime(replay.startTime, "Unknown")}</dd></div>
        <div><dt>Game time</dt><dd>{replay.gameDurationSeconds !== null ? formatDuration(replay.gameDurationSeconds) : "Unknown"}</dd></div>
        <div><dt>Real time</dt><dd>{replay.durationSeconds !== null ? formatDuration(replay.durationSeconds) : "Unknown"}</dd></div>
        <div><dt>Players</dt><dd>{totalPlayers}</dd></div>
        <div><dt>Avg rating</dt><dd>{replay.averageRating !== null ? replay.averageRating : "Unrated"}</dd></div>
        <div><dt>Featured mod</dt><dd>{replay.modName || "Unknown"}</dd></div>
      </dl>

      <section className="replay-detail-lineup">
        <div className="replay-detail-section-head">
          <div>
            <span className="replay-detail-eyebrow">Lineup</span>
            <h3>{lineupSummary}</h3>
          </div>
          {hasResults && (
            <Button aria-pressed={showResults} onClick={() => setShowResults((visible) => !visible)}>
              {showResults ? "Hide results" : "Reveal results"}
            </Button>
          )}
        </div>
        {replay.teams.length > 0 ? (
          <ReplayDetailRoster teams={replay.teams} showResults={showResults} />
        ) : (
          <p className="replay-detail-empty muted">No lineup was recorded for this replay.</p>
        )}
      </section>
    </Modal>
  );
}
