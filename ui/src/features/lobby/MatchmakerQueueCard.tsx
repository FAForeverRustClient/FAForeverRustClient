import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { MatchmakerQueue, PlayerLeaguePlacement, PlayerRatingSummary } from "../../ipc/bindings";
import { UNLISTED_DIVISION_IMAGE } from "./MatchmakerPlayerCard";
import { formatClockDuration } from "../../shared/durations";
import { queueRatingBuckets } from "./queueRatingRange";
import { t } from "../../i18n";

export type QueueDisplayState = "idle" | "searching" | "found" | "launching" | "cancelled";

/**
 * Every queue is named by its team size, the ladder included. Calling that one
 * "Ranked 1 vs 1" while the rest went by their size implied the others were
 * unranked, which none of them are.
 */
export function queueTitle(queue: MatchmakerQueue) {
  return `${queue.teamSize} vs ${queue.teamSize}`;
}


interface Props {
  queue: MatchmakerQueue;
  selected: boolean;
  /**
   * Nothing about this queue can be changed: the party has a leader and it is
   * somebody else, or a match is already being made.
   */
  disabled: boolean;
  /**
   * The party does not fit in it.
   *
   * Not the same as [`disabled`], and the difference was a bug report: a queue
   * your party has outgrown is one you cannot *join*, and it was drawn as one
   * you cannot touch, so a 1v1 left selected before inviting somebody could
   * not be switched off again. Selecting stays refused; deselecting is exactly
   * what the player is trying to do.
   */
  incompatible: boolean;
  status: QueueDisplayState;
  activeGames: number;
  secondsUntilPop: number;
  rating: PlayerRatingSummary | null;
  /**
   * Searches in this queue whose rating window contains yours, or `null` when
   * that cannot be said - see `playersInRatingRange`. `null` is not zero: an
   * unrated queue and an empty one are different facts and only one of them is
   * worth a number.
   */
  inRange: number | null;
  /** Your own search in this queue, which the server counts and you are not
   *  looking for. The breakdown has to subtract it in the same place the
   *  headline count does. */
  ownSearches: number;
  /** This queue's league placement, for the badge under the rating. */
  placement: PlayerLeaguePlacement | null;
  onToggle: () => void;
  onOpenMapPool: () => void;
}

export function MatchmakerQueueCard({
  queue,
  selected,
  disabled,
  incompatible,
  status,
  activeGames,
  secondsUntilPop,
  rating,
  inRange,
  ownSearches,
  placement,
  onToggle,
  onOpenMapPool,
}: Props) {
  // Who is actually waiting, by rating. "10 queued" says nothing about whether
  // any of them is near you, and "in range: 0" says only that none is: the
  // question both leave open is whether the queue is empty around your rating
  // or empty everywhere, which decides whether waiting is worth it.
  const buckets = queueRatingBuckets(queue, rating, ownSearches);
  return (
    <article
      className={
        `matchmaker-queue-card surface-panel${selected ? " is-selected" : ""}`
        + `${disabled || incompatible ? " incompatible" : ""}`
      }
      data-status={status}
    >
      {/* The whole card toggles, not a checkbox-sized strip at the top of it.
          Everything below is either a fact about the queue or a separate
          action, so a card-wide target is unambiguous and much easier to hit. */}
      <button
        type="button"
        className="matchmaker-queue-select"
        aria-pressed={selected}
        // A queue the party has outgrown can still be switched off: that is
        // the only thing left to do with it, and refusing both directions is
        // what made an outgrown 1v1 permanent.
        disabled={disabled || (incompatible && !selected)}
        title={incompatible && selected
          ? t("lobby.matchmaker.queueDropTooLarge", { queue: queueTitle(queue) })
          : t(selected ? "lobby.matchmaker.queueInSearch" : "lobby.matchmaker.queueAddToSearch", {
            queue: queueTitle(queue),
          })}
        onClick={onToggle}
      >
        <span className="matchmaker-queue-head">
          <span className="matchmaker-queue-check" aria-hidden>{selected ? "✓" : ""}</span>
          <span className="matchmaker-queue-title">
            <strong>{queueTitle(queue)}</strong>
          </span>
          {/* Your rating is the number that decides whether you want this
              queue at all, so it leads rather than sharing a row of four
              equally sized statistics. */}
          <span className="matchmaker-queue-rating">
            <strong>{rating ? rating.rating.toLocaleString("en-US") : "N/A"}</strong>
            <small>{rating ? "your rating" : "unrated"}</small>
            {/* The division for *this* queue, under its rating. A player is
                placed per leaderboard, so the badge only means anything next
                to the queue it belongs to. */}
            <img
              className="matchmaker-queue-division"
              src={placement?.imageUrl || UNLISTED_DIVISION_IMAGE}
              alt=""
              title={placement?.division || undefined}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={(event) => { event.currentTarget.src = UNLISTED_DIVISION_IMAGE; }}
            />
          </span>
        </span>

        {/* One fact per line. Four of them wrapped across a card this narrow
            broke wherever the numbers happened to be widest, so the same card
            read differently for a four digit rating than for a three digit one,
            and the one that decides whether to queue, how many of those waiting
            would actually match you, was whichever fragment landed last. */}
        <span className="matchmaker-queue-facts">
          <span><Icon name="hourglass" size={14} /> {formatClockDuration(secondsUntilPop)}</span>
          <span className="matchmaker-queue-queued">
            <Icon name="users" size={14} /> {t("lobby.matchmaker.queuedCount", { count: queue.numPlayers })}
            {buckets.length > 0 && (
              // Shown while the pointer is anywhere on the card, and anchored
              // here because this is the count it breaks down. Hover-only and
              // `pointer-events: none`, because this sits inside the card's
              // own button and a focusable popover in there would be a control
              // inside a control.
              <span className="matchmaker-queue-breakdown" aria-hidden>
                <b>{t("lobby.matchmaker.queueByRating")}</b>
                {buckets.map((bucket) => (
                  <span
                    key={bucket.min}
                    className={[
                      bucket.inRange > 0 ? "is-in-range" : "",
                      bucket.mine ? "is-mine" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <em>{bucket.min} – {bucket.max}</em>
                    {/* Which of the band is a fair match, whenever that
                        differs from how many are in it -- *including* when
                        none of them are.

                        "0 of 5" was the one case this left out, and it is the
                        case the whole breakdown exists for: a band printed as
                        a bare "5" next to a headline of "0 in your range" is
                        the same contradiction the per-band figure was added to
                        settle, and it is the band nearest your own rating that
                        hits it. A band is bucketed by the middle of each
                        search's window, so five searches can sit in the band
                        your rating is in and none of their windows reach you.
                        See `RatingBucket.inRange`. */}
                    <i>{bucket.inRange === bucket.count
                      ? bucket.count
                      : t("lobby.matchmaker.someOfBand", { inRange: bucket.inRange, count: bucket.count })}</i>
                  </span>
                ))}
                {buckets.some((bucket) => bucket.mine) && (
                  <small>{t("lobby.matchmaker.yourBand")}</small>
                )}
              </span>
            )}
          </span>
          <span><Icon name="play" size={14} /> {t("lobby.matchmaker.activeCount", { count: activeGames })}</span>
          {inRange !== null && (
            <span title={t("lobby.matchmaker.inRangeHint")}>
              <Icon name="check" size={14} /> {t("lobby.matchmaker.inRange", { count: inRange })}
            </span>
          )}
          {/* Only for the size, which is the one the note names. A card
              disabled because somebody else leads the party said "party too
              large" as well, which is a different fact and not true. */}
          {incompatible && (
            <span className="matchmaker-queue-note">{t("lobby.matchmaker.partyTooLarge")}</span>
          )}
        </span>
      </button>

      {/* Parked in the bottom right corner of the card rather than given a row
          of its own: the button is the same height as the fact lines it sits
          beside, so it costs the card nothing. */}
      <div className="matchmaker-queue-footer">
        <Button className="matchmaker-map-pool-button" onClick={onOpenMapPool}>
          <Icon name="maps" size={15} /> {t("lobby.matchmaker.mapPool")}
        </Button>
      </div>
    </article>
  );
}
