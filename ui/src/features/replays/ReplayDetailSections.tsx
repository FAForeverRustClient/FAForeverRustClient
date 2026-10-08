// The replay detail panel's sections below the hero: the generator's
// progress, the facts, the lineup, and the toolbar along the floor.

import { memo, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { GeneratorStatus, VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatDecimal } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { formatDate, formatTime } from "../../shared/format/dates";
import { formatDuration } from "../../shared/format/durations";
import { GeneratorFailure } from "../../shared/components/GeneratorFailure";
import type { PlayerMenuOpener } from "../../shared/hooks/usePlayerMenu";
import type { mapSize } from "../../shared/mapPresentation";
import { openReviews } from "../../shared/openReviews";
import { useAppStore } from "../../store/store";
import { ReplayDetailRoster } from "./ReplayRoster";
import { useHasReplayNote } from "./ReplayNotesEditor";
import type { GeneratorProgress } from "./replayDetailPresentation";
import type { GameRating } from "./useGameRating";

type ReplayTeams = Parameters<typeof ReplayDetailRoster>[0]["teams"];

/** The generator's progress while it builds this map, and its failure if it fails. */
export function ReplayGenerationNotice({
  status,
  running,
  progress,
  onRetry,
}: {
  status: GeneratorStatus;
  running: boolean;
  progress: GeneratorProgress | null;
  /** Generate this replay's map again; absent where there is nothing to run. */
  onRetry?: () => void;
}) {
  return (
    <>
      {running && progress && (
        <div className="replay-generation-banner">
          <div className="replay-generation-banner-content">
            <Icon name="refresh" size={14} className="spin replay-generation-spinner" />
            <span className="replay-generation-banner-text">{progress.label}</span>
            {progress.percent !== null && (
              <span className="replay-generation-banner-pct">{progress.percent}%</span>
            )}
          </div>
          {progress.percent !== null ? (
            <div className="replay-generation-progress-track">
              <div
                className="replay-generation-progress-fill"
                style={{ transform: `scaleX(${progress.percent / 100})` }}
              />
            </div>
          ) : (
            <div className="replay-generation-progress-track indeterminate">
              <div className="replay-generation-progress-fill" />
            </div>
          )}
        </div>
      )}
      {status.type === "failed" && <GeneratorFailure reason={status.payload.reason} onRetry={onRetry} />}
    </>
  );
}

/**
 * Ten facts in two rows of five, paired by column: date over time,
 * the two durations (routinely minutes apart, and the difference is
 * the point of showing both), players over mod, the two numbers about
 * the game's standing, and the map's size over the community's score
 * for the replay.
 *
 * Memoised, as the lineup below is: the panel redraws for every step of the
 * map generator's progress and every answer the replays slice receives, and
 * none of these props changes with them.
 */
export const ReplayDetailFacts = memo(function ReplayDetailFacts({
  replay,
  totalPlayers,
  size,
  rating,
  cardTitle,
}: {
  replay: VaultReplay;
  totalPlayers: number;
  size: ReturnType<typeof mapSize>;
  rating: GameRating;
  cardTitle: string;
}) {
  const { t } = useTranslation();
  const offline = useAppStore((state) => state.state.auth.mode === "offline");
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
  return (
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
  );
});

/** Memoised: the roster is the largest part of the panel. */
export const ReplayDetailLineup = memo(function ReplayDetailLineup({
  lineupSummary,
  rated,
  notRated,
  teams,
  onPlayerMenu,
}: {
  /** The section's accessible name: teams and players, or just "Lineup". */
  lineupSummary: string;
  /** Whether there is a result to show; see `hasGameResult`. */
  rated: boolean;
  /** Why the result is missing or did not count, if it is or did not. */
  notRated: string | null;
  teams: ReplayTeams;
  onPlayerMenu?: PlayerMenuOpener;
}) {
  const { t } = useTranslation();
  const socialPlayers = useAppStore((state) => state.state.social.players);
  const [showResults, setShowResults] = useState(false);
  const avatarByLogin = useMemo(() => {
    const avatars = new Map<string, string>();
    for (const player of socialPlayers) {
      if (player.avatarUrl) avatars.set(player.login.toLocaleLowerCase(), player.avatarUrl);
    }
    return avatars;
  }, [socialPlayers]);

  return (
    <section className="replay-detail-lineup" aria-label={lineupSummary}>
      {/* Top right over the teams: the result switch, with the reason it is
          missing in its place. There is no dead button: a game with no
          result to show says why instead, and an unrated game with a
          decisive outcome has both a winner and a reason it did not count
          (see `hasGameResult`). The count of teams and players is not
          repeated here: the team headings and the facts already say it, and
          the section keeps it as its accessible name. */}
      <div className="replay-detail-section-head replay-detail-section-head-end">
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
      {teams.length > 0 ? (
        <ReplayDetailRoster
          teams={teams}
          showResults={showResults}
          avatarByLogin={avatarByLogin}
          onPlayerMenu={onPlayerMenu}
          titlesAbove
        />
      ) : (
        <p className="replay-detail-empty muted">{t("replays.detail.noLineup")}</p>
      )}
    </section>
  );
});

/**
 * Every other action on the replay, as one flat toolbar along the
 * dialog's floor, in the order they are reached for.
 */
export function ReplayDetailToolbar({
  replay,
  onDownload,
  downloadState,
  localPath,
  onClose,
  watched,
  onToggleWatched,
  showNotes,
  onOpenNotes,
  showInsights,
  onOpenInsights,
  isLoadingDetails,
}: {
  replay: VaultReplay;
  onDownload?: () => void;
  downloadState: "idle" | "downloading" | "downloaded" | "failed";
  localPath: string | undefined;
  onClose: () => void;
  watched: boolean;
  onToggleWatched?: () => void;
  showNotes: boolean;
  onOpenNotes: () => void;
  showInsights: boolean;
  onOpenInsights: () => void;
  isLoadingDetails: boolean;
}) {
  const { t } = useTranslation();
  const hasNote = useHasReplayNote(replay.uid, localPath);
  return (
    <div className="replay-detail-toolbar">
      {onDownload && (
        <Button
          className="replay-detail-tool"
          disabled={!replay.replayAvailable || downloadState === "downloading" || downloadState === "downloaded"}
          onClick={onDownload}
          title={t("replays.detail.downloadReplay")}
        >
          <Icon name="download" size={16} />
          <span>{t(downloadState === "downloading"
            ? "replays.detail.downloading"
            : downloadState === "downloaded"
              ? "replays.detail.downloaded"
              : "replays.detail.downloadShort")}</span>
        </Button>
      )}
      {/* The shortest path from "that game went badly" to a request
          someone can answer. Naming the replay rather than passing the
          details is deliberate: the training service reads them back out
          of state, so this button cannot prefill the form with anything
          the client does not actually know. */}
      <Button
        className="replay-detail-tool"
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
        <Icon name="book" size={16} />
        <span>{t("replays.detail.requestReviewShort")}</span>
      </Button>
      {/* Watching sets the mark, and a mark that cannot be cleared is a
          mistake nobody can take back, so the panel carries the switch:
          a card is itself a button and cannot hold one. A toggle keeps
          one name and says its state by being pressed; the tooltip says
          what pressing it again does. */}
      {onToggleWatched && (
        <Button
          className={watched ? "replay-detail-tool is-on" : "replay-detail-tool"}
          aria-pressed={watched}
          onClick={onToggleWatched}
          title={t(watched ? "replays.watched.unmark" : "replays.watched.mark")}
        >
          <Icon name={watched ? "check" : "eye"} size={16} />
          <span>{t("replays.watched.mark")}</span>
        </Button>
      )}
      {/* The reader's own comment and tags (#324), in an overlay: most
          replays have none. Lit when there is a note, so a tagged game
          says so before it is opened. A file without a game id keeps its
          note on its path, so only a replay with neither goes without. */}
      {(replay.uid > 0 || Boolean(localPath)) && (
        <Button
          className={hasNote ? "replay-detail-tool is-on" : "replay-detail-tool"}
          aria-haspopup="dialog"
          aria-expanded={showNotes}
          onClick={onOpenNotes}
          title={t("replays.notes.open")}
        >
          <Icon name="edit" size={16} />
          <span>{t("replays.notes.open")}</span>
        </Button>
      )}
      {/* What the replay file itself holds: chat, options, mods and the
          analysis tabs. */}
      <Button
        className="replay-detail-tool"
        onClick={onOpenInsights}
        aria-haspopup="dialog"
        aria-expanded={showInsights}
        title={t("replays.insights.openHint")}
      >
        <Icon name={isLoadingDetails ? "refresh" : "list"} size={16} className={isLoadingDetails ? "spin" : undefined} />
        <span>{t("replays.detail.loadDetailsShort")}</span>
      </Button>
    </div>
  );
}
