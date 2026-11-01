import { useMemo, type PointerEvent } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { MatchmakerQueue, PlayerLeaguePlacement, PlayerRatingSummary } from "../../../ipc/bindings";
import { UNLISTED_DIVISION_IMAGE } from "./MatchmakerPlayerCard";
import { formatClockDuration } from "../../../shared/format/durations";
import { placementLabel } from "../../../shared/leagueNames";
import {
  queueRatingGraph,
  RATING_GRAPH_DOMAIN,
  RATING_GRAPH_TICKS,
  type QueueRatingGraph,
} from "./queueRatingRange";
import { formatNumber, t } from "../../../i18n";

const PLOT_WIDTH = 204;
const PLOT_HEIGHT = 76;
const PLOT_PAD = { left: 8, right: 8, top: 8, bottom: 18 };

function QueueRatingPlot({ graph }: { graph: QueueRatingGraph }) {
  const [from, to] = RATING_GRAPH_DOMAIN;
  const innerWidth = PLOT_WIDTH - PLOT_PAD.left - PLOT_PAD.right;
  const base = PLOT_HEIGHT - PLOT_PAD.bottom;
  const usableHeight = base - PLOT_PAD.top;
  const x = (rating: number) => PLOT_PAD.left + ((rating - from) / (to - from)) * innerWidth;
  const y = (value: number) => base - value * usableHeight;

  const coords = graph.points.map((point) => `${x(point.rating).toFixed(1)},${y(point.value).toFixed(1)}`);
  const linePath = `M ${coords.join(" L ")}`;
  const areaPath = `${linePath} L ${x(to).toFixed(1)},${base} L ${x(from).toFixed(1)},${base} Z`;

  return (
    <svg
      className="matchmaker-queue-plot"
      viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
      aria-hidden
    >
      <line
        className="matchmaker-queue-grid"
        x1={PLOT_PAD.left}
        x2={PLOT_WIDTH - PLOT_PAD.right}
        y1={base - usableHeight * 0.5}
        y2={base - usableHeight * 0.5}
      />
      <path className="matchmaker-queue-curve-fill" d={areaPath} />
      <path className="matchmaker-queue-curve-line" d={linePath} />
      <line
        className="matchmaker-queue-axis"
        x1={PLOT_PAD.left}
        x2={PLOT_WIDTH - PLOT_PAD.right}
        y1={base}
        y2={base}
      />
      {RATING_GRAPH_TICKS.map((tick, index) => (
        <g key={tick}>
          <line
            className="matchmaker-queue-axis"
            x1={x(tick)}
            x2={x(tick)}
            y1={base}
            y2={base + 3}
          />
          <text
            className="matchmaker-queue-tick"
            x={x(tick)}
            y={PLOT_HEIGHT - 2}
            textAnchor={
              index === 0
                ? "start"
                : index === RATING_GRAPH_TICKS.length - 1
                  ? "end"
                  : "middle"
            }
          >
            {formatNumber(tick)}
          </text>
        </g>
      ))}
      {graph.marker && (
        <g className="matchmaker-queue-marker">
          <line
            className="matchmaker-queue-marker-line"
            x1={x(graph.marker.rating)}
            x2={x(graph.marker.rating)}
            y1={PLOT_PAD.top}
            y2={base}
          />
          <circle
            className="matchmaker-queue-marker-halo"
            cx={x(graph.marker.rating)}
            cy={y(graph.marker.value)}
            r={4.5}
          />
          <circle
            className="matchmaker-queue-marker-dot"
            cx={x(graph.marker.rating)}
            cy={y(graph.marker.value)}
            r={2.75}
          />
        </g>
      )}
    </svg>
  );
}

/**
 * The rating breakdown opens above the card. Whatever scrolls the tab clips
 * what leaves it, so a card scrolled up to that box's top edge has no room
 * there, and its breakdown opens below the card instead. Which box scrolls
 * depends on the window's size (see `matchmaker.css`), so it is looked up
 * rather than named. Decided as the pointer arrives, which is when the
 * breakdown is about to show.
 */
function placeBreakdown(event: PointerEvent<HTMLElement>) {
  const card = event.currentTarget;
  const breakdown = card.querySelector<HTMLElement>(".matchmaker-queue-breakdown");
  if (!breakdown) return;
  let clip = card.parentElement;
  while (clip && getComputedStyle(clip).overflowY === "visible") clip = clip.parentElement;
  const top = clip ? clip.getBoundingClientRect().top : 0;
  const room = card.getBoundingClientRect().top - top;
  card.dataset.breakdown = room < breakdown.offsetHeight + 8 ? "below" : "above";
}

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
  placement,
  onToggle,
  onOpenMapPool,
}: Props) {
  // Who is actually waiting, by rating. "10 queued" says nothing about whether
  // any of them is near you, and "in range: 0" says only that none is: the
  // question both leave open is whether the queue is empty around your rating
  // or empty everywhere, which decides whether waiting is worth it.
  const graph = useMemo(() => queueRatingGraph(queue, rating), [queue, rating?.mean, rating?.deviation, rating?.gamesPlayed]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <article
      className={
        `matchmaker-queue-card surface-panel${selected ? " is-selected" : ""}`
        + `${disabled || incompatible ? " incompatible" : ""}`
      }
      data-status={status}
      onPointerEnter={graph ? placeBreakdown : undefined}
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
        // The card already says which queue it is and draws itself differently
        // once it is in the search, so a native tooltip repeating that in
        // words was only ever in the way: it opens on the same hover as the
        // rating breakdown below and lands on top of it. The sentence still
        // reaches a screen reader, where nothing else carries it.
        //
        // The one state that keeps its tooltip is the outgrown queue, because
        // there the click does the opposite of what a card that cannot be
        // selected suggests, and that is worth a sentence.
        aria-label={t(selected ? "lobby.matchmaker.queueInSearch" : "lobby.matchmaker.queueAddToSearch", {
          queue: queueTitle(queue),
        })}
        title={incompatible && selected
          ? t("lobby.matchmaker.queueDropTooLarge", { queue: queueTitle(queue) })
          : undefined}
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
            <strong>{rating ? formatNumber(rating.rating) : t("common.notAvailable")}</strong>
            <small>{t(rating ? "lobby.matchmaker.yourRating" : "lobby.matchmaker.unratedHint")}</small>
            {/* The division for *this* queue, under its rating. A player is
                placed per leaderboard, so the badge only means anything next
                to the queue it belongs to. */}
            <img
              className="matchmaker-queue-division"
              src={placement?.imageUrl || UNLISTED_DIVISION_IMAGE}
              alt=""
              title={placementLabel(placement) ?? t("lobby.matchmaker.unplaced")}
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
          <span><Icon name="hourglass" size={16} /> {formatClockDuration(secondsUntilPop)}</span>
          <span className="matchmaker-queue-queued">
            <Icon name="users" size={16} /> {t("lobby.matchmaker.queuedCount", { count: queue.numPlayers })}
            {graph && (
              // Shown while the pointer is anywhere on the card, and anchored
              // here because this is the count it breaks down. Hover-only and
              // `pointer-events: none`, because this sits inside the card's
              // own button and a focusable popover in there would be a control
              // inside a control.
              <span className="matchmaker-queue-breakdown" aria-hidden>
                <span className="matchmaker-queue-breakdown-head">
                  <b>{t("lobby.matchmaker.queueByRating")}</b>
                </span>
                <QueueRatingPlot graph={graph} />
              </span>
            )}
          </span>
          <span><Icon name="play" size={16} /> {t("lobby.matchmaker.activeCount", { count: activeGames })}</span>
          {/* Always a line, invisible while there is no answer. The answer
              needs your rating, which arrives after the tab has drawn, and a
              line added then made every card taller and pushed the page
              down a moment after it opened. */}
          <span
            className={inRange === null ? "matchmaker-queue-fact-pending" : undefined}
            title={inRange === null ? undefined : t("lobby.matchmaker.inRangeHint")}
            aria-hidden={inRange === null || undefined}
          >
            <Icon name="check" size={16} /> {t("lobby.matchmaker.inRange", { count: inRange ?? 0 })}
          </span>
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
