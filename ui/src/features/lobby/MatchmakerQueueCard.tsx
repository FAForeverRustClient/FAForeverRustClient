import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { MatchmakerQueue, PlayerRatingSummary } from "../../ipc/bindings";
import { formatClockDuration } from "../../shared/durations";
import { t } from "../../i18n";

export type QueueDisplayState = "idle" | "searching" | "found" | "launching" | "cancelled";

export function queueTitle(queue: MatchmakerQueue) {
  if (queue.queueName.toLocaleLowerCase() === "ladder1v1") return t("lobby.matchmaker.queue.ranked1v1");
  return `${queue.teamSize} vs ${queue.teamSize}`;
}

function statusText(status: QueueDisplayState) {
  switch (status) {
    case "searching": return t("lobby.matchmaker.state.searching");
    case "found": return t("lobby.matchmaker.state.found");
    case "launching": return t("lobby.matchmaker.state.launching");
    case "cancelled": return t("lobby.matchmaker.state.cancelled");
    case "idle": return null;
  }
}

interface Props {
  queue: MatchmakerQueue;
  selected: boolean;
  disabled: boolean;
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
  onToggle: () => void;
  onOpenMapPool: () => void;
}

export function MatchmakerQueueCard({
  queue,
  selected,
  disabled,
  status,
  activeGames,
  secondsUntilPop,
  rating,
  inRange,
  onToggle,
  onOpenMapPool,
}: Props) {
  const statusLabel = statusText(status);
  return (
    <article className={`matchmaker-queue-card surface-panel${selected ? " is-selected" : ""}${disabled ? " incompatible" : ""}`} data-status={status}>
      {/* The whole card toggles, not a checkbox-sized strip at the top of it.
          Everything below is either a fact about the queue or a separate
          action, so a card-wide target is unambiguous and much easier to hit. */}
      <button
        type="button"
        className="matchmaker-queue-select"
        aria-pressed={selected}
        disabled={disabled}
        title={selected ? `${queueTitle(queue)} is in your search` : `Add ${queueTitle(queue)} to your search`}
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
          </span>
        </span>

        <span className="matchmaker-queue-facts">
          <span><Icon name="hourglass" size={14} /> {formatClockDuration(secondsUntilPop)}</span>
          <span><Icon name="users" size={14} /> {queue.numPlayers} queued</span>
          <span><Icon name="play" size={14} /> {activeGames} active</span>
          {/* The number that decides whether waiting is worth it: how many of
              those queued would actually be matched with you. */}
          {inRange !== null && (
            <span title={t("lobby.matchmaker.inRangeHint")}>
              <Icon name="check" size={14} /> {t("lobby.matchmaker.inRange", { count: inRange })}
            </span>
          )}
        </span>
      </button>

      <div className="matchmaker-queue-footer">
        <Button className="matchmaker-map-pool-button" onClick={onOpenMapPool}>
          <Icon name="maps" size={15} /> {t("lobby.matchmaker.mapPool")}
        </Button>
        {disabled ? <span className="matchmaker-queue-note">{t("lobby.matchmaker.partyTooLarge")}</span> : statusLabel ? <span className="matchmaker-queue-status"><i />{statusLabel}</span> : null}
      </div>
    </article>
  );
}
