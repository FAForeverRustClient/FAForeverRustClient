// A replay as a card: the vault's and the local library's, the facts they
// share, and the map art both lead with.

import { Icon, type IconName } from "../../design-system/Icon";
import type { ReplayTeam, VaultReplay } from "../../ipc/bindings";
import { formatAgeOrDate, formatShortDateTime } from "../../shared/format/dates";
import { formatDuration } from "../../shared/format/durations";
import { effectiveReplayMapName } from "../../shared/mapPresentation";
import { MapThumbnail } from "../../shared/components/MapThumbnail";
import type { PlayerMenuOpener } from "../../shared/hooks/usePlayerMenu";
import { replayMapKey, replayMapPresentation } from "./coopReplayMap";
import { useAppStore } from "../../store/store";
import { playerCount, ReplayCardRoster, mergeReplayTeamsWithLocal } from "./ReplayRoster";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * "3d ago" beside the replay id, so recency reads without parsing a date --
 * and the date itself once "how long ago" has stopped being readable.
 */
export function replayAge(startTime: string): string {
  return formatAgeOrDate(startTime);
}

/**
 * The selector's answer when nothing has been resolved yet.
 *
 * A literal `{}` inside the selector would be a new object on every render,
 * which is a new value to the store's identity check and a render loop.
 */
export const NO_RESOLVED_MAPS: Record<number, string> = {};

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
      {/* Date *and* time of day. The date alone answers "which day was this"
          and not "which of that evening's games was this", which is the
          question someone scanning their own recent replays is actually
          asking: the list view has printed the clock time in its Played column
          all along, and the card was the odd one out. */}
      <ReplayMetaFact
        icon="calendar"
        label={t("replays.card.played")}
        value={formatShortDateTime(replay.startTime, "")}
      />
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

/**
 * A replay's map art: the shared thumbnail, with the listing's own URL tried
 * as one more candidate.
 *
 * This used to walk the remote candidates itself and stop at a broken image.
 * For a campaign mission every remote candidate 404s, because the content
 * server has no art for any of them; `MapThumbnail` knows that, reads the
 * preview out of the installed map folder, and draws the faction badge when
 * even that is missing. Wrapping it is what makes a co-op game in the live
 * list look like a co-op game in the Play tab.
 */
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
  return (
    <MapThumbnail
      mapName={mapName}
      vault={vault}
      url={url}
      className={className}
      placeholderClassName={`${className} ${emptyClassName}`}
      iconSize={iconSize}
      large={large}
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
  onPlayerMenu,
}: {
  replay: ReplayCardData;
  watched: boolean;
  selected?: boolean;
  /** The footer's action. See `ReplayCardWatch`. */
  watch?: ReplayCardWatch;
  onOpen: () => void;
  onDoubleClick?: () => void;
  /** Opens the chat player menu on a name in the lineup. */
  onPlayerMenu?: PlayerMenuOpener;
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
        <ReplayCardRoster teams={replay.teams} onPlayerMenu={onPlayerMenu} />
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
  onPlayerMenu,
}: {
  replay: VaultReplay;
  watched: boolean;
  /** A game is already starting, so a second "watch" would go nowhere. */
  busy?: boolean;
  onOpen: () => void;
  onDoubleClick?: () => void;
  onWatch?: () => void;
  /** Opens the chat player menu on a name in the lineup. */
  onPlayerMenu?: PlayerMenuOpener;
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
      onPlayerMenu={onPlayerMenu}
    />
  );
}
