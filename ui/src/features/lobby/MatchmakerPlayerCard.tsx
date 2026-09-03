import { memo } from "react";
import type { MatchmakerPlayerProfile, MatchmakerQueue, PlayerCardStatus, PlayerRatingSummary } from "../../ipc/bindings";
import { placementForQueue, ratingForQueue } from "./matchmakerRatings";
import { flagSrc } from "../../shared/countryFlags";
import { openPlayerCard } from "../player-card/playerCardActions";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";

/**
 * The badge shown for a queue the player has no placement in. Taken from the
 * Java client (`images/leagueUnlistedDivision.png`) so the two clients say
 * "unplaced" with the same picture rather than each inventing one.
 */
export const UNLISTED_DIVISION_IMAGE = "/images/league-unlisted-division.png";

/**
 * The short form a queue is named by here: "1v1", "4v4". `queueTitle` spells
 * the ladder queue out for the cards, which is too long for a caption.
 */
const queueLabel = (queue: MatchmakerQueue) => `${queue.teamSize}v${queue.teamSize}`;

interface Props {
  playerId: number | null;
  playerName: string;
  profile: MatchmakerPlayerProfile | null;
  status: PlayerCardStatus;
  error: string;
  /**
   * ISO country code from the *lobby* directory, not the REST profile.
   *
   * `/data/player` does not carry a country, so the API-sourced profile always
   * had an empty one and the flag never rendered. The lobby's `player_info`
   * push does carry it, already lowercased, which is also where the Java
   * client's `countryImageView` gets it.
   */
  country: string;
  /** The queues whose ratings the headline number is picked from. */
  queues: MatchmakerQueue[];
}

/**
 * Memoised because the panel around it holds a one second clock for the queue
 * countdowns, and none of this changes on that tick.
 */
export const MatchmakerPlayerCard = memo(function MatchmakerPlayerCard({
  playerId,
  playerName,
  profile,
  status,
  error,
  country,
  queues,
}: Props) {
  const { t } = useTranslation();
  const placements = profile?.leaguePlacements ?? [];
  // One division and one number, not a row of four. Per queue tiles turned the
  // identity card into a table nobody read across, while the fact a player
  // actually wants back from it is the best they currently hold.
  // `parse_placements` already sorts Java's highest active division first.
  const placement = placements[0] ?? null;
  const placementQueue = placement
    ? queues.find((queue) => placementForQueue(placements, queue.queueName) === placement) ?? null
    : null;

  let best: { label: string; rating: PlayerRatingSummary } | null = null;
  for (const queue of queues) {
    const rating = ratingForQueue(profile?.ratings ?? [], queue.queueName);
    if (rating && (best === null || rating.rating > best.rating.rating)) {
      best = { label: queueLabel(queue), rating };
    }
  }

  // Java's league arc is `score / subdivision.highestScore()`
  // (`LeaderboardPlayerDetailsController`). The placement knows the ceiling of
  // the band it sits in but never the name of the one above it, so the caption
  // counts points rather than naming a destination.
  const ceiling = placement && placement.highestScore > 0 ? placement.highestScore : null;
  const remaining = placement && ceiling !== null ? Math.max(0, ceiling - placement.score) : null;
  const progress = placement && ceiling !== null
    ? Math.min(100, Math.max(0, Math.round((placement.score / ceiling) * 100)))
    : null;

  const displayName = profile?.login || playerName;
  const clan = profile?.clanTag ? `[${profile.clanTag}]` : "";
  // The REST profile keeps its country only as a fallback; in practice the
  // lobby is the source that actually has one.
  const flagCode = country || profile?.country || "";

  return (
    <section className="matchmaker-player-card surface-panel" aria-labelledby="matchmaker-player-name">
      <div className="matchmaker-player-copy">
        <button
          type="button"
          className="matchmaker-player-name"
          id="matchmaker-player-name"
          disabled={playerId === null}
          title={t("lobby.matchmaker.openProfile")}
          onClick={() => { if (playerId !== null) void openPlayerCard(playerId, displayName); }}
        >
          {clan && <span>{clan}</span>}
          <strong><PlayerName name={displayName} /></strong>
          {profile?.avatarUrl && (
            <img
              className="matchmaker-player-avatar"
              src={profile.avatarUrl}
              alt=""
              width={40}
              height={20}
              title={profile.avatarTooltip || undefined}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          )}
        </button>
        <div className="matchmaker-player-meta">
          {flagCode && (
            <img
              src={flagSrc(flagCode)}
              alt={flagCode.toUpperCase()}
              title={flagCode.toUpperCase()}
              width={20}
              height={14}
            />
          )}
          <span>{profile ? t("lobby.playerCard.games", { count: formatNumber(profile.gamesPlayed) }) : t("lobby.playerCard.ratingsLoading")}</span>
        </div>
        {status === "failed" && <small className="matchmaker-profile-warning" title={error}>{t(profile ? "lobby.playerCard.refreshFailed" : "lobby.playerCard.unavailable")}</small>}
        {profile && profile.warnings.length > 0 && <small className="matchmaker-profile-warning" title={profile.warnings.join("\n")}>{t("lobby.matchmaker.detailsUnavailable")}</small>}
      </div>

      {/* The headline of the tab: the best division and the best rating the
          account holds, at a size that reads at a glance. */}
      <div className="matchmaker-league-summary">
        <img
          className="matchmaker-league-summary-badge"
          src={placement?.imageUrl || UNLISTED_DIVISION_IMAGE}
          alt=""
          title={placement?.division || undefined}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={(event) => { event.currentTarget.src = UNLISTED_DIVISION_IMAGE; }}
        />

        <div className="matchmaker-league-summary-copy">
          <span className="matchmaker-kicker">
            {t("lobby.matchmaker.highestDivision")}
            {placementQueue && <em>{queueLabel(placementQueue)}</em>}
          </span>
          <strong className="matchmaker-league-summary-division">
            {placement?.division || t(status === "loading" ? "lobby.playerCard.loadingPlacement" : "lobby.matchmaker.unplaced")}
          </strong>
          {placement && (
            <>
              {progress !== null && ceiling !== null && (
                <span
                  className="matchmaker-league-progress"
                  role="img"
                  aria-label={t("lobby.matchmaker.leagueProgress", {
                    score: formatNumber(placement.score),
                    target: formatNumber(ceiling),
                  })}
                >
                  <span style={{ width: `${progress}%` }} />
                </span>
              )}
              {/* Points, not a name: the API tells the client where this band
                  ends, so promising "Gold I" would be a guess. */}
              <small>
                {remaining !== null && remaining > 0
                  ? t("lobby.matchmaker.toNextDivision", { count: remaining, points: formatNumber(remaining) })
                  : t("lobby.matchmaker.leagueScore", { count: placement.score, points: formatNumber(placement.score) })}
              </small>
            </>
          )}
        </div>

        <div className="matchmaker-league-summary-rating">
          <span className="matchmaker-kicker">{t("lobby.matchmaker.topRating")}</span>
          <strong className={best ? undefined : "is-empty"}>
            {best ? formatNumber(best.rating.rating) : t("lobby.matchmaker.noRating")}
          </strong>
          {best && <small>{best.label}</small>}
        </div>
      </div>
    </section>
  );
});
