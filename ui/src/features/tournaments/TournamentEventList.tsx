// The event list: drafts, ongoing and upcoming events, then the archive folded
// away by year.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { Tourney } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import {
  countdownTo,
  formatDay,
  formatPrize,
  groupedEvents,
  type ListGroup,
} from "./tourneyPresentation";
import {
  archiveByYear,
  eventDayCount,
  eventDaysLabel,
  listCountdowns,
  listKind,
  listRatingLine,
  listTeamsLine,
  statusPill,
} from "./orientation";
import { send } from "./tourneyCommands";
import type { EventListFold } from "./useEventListFold";

/**
 * The three groups that are always open, in the order they are read.
 *
 * The website's order: your drafts, then what is being played right now, then
 * what is coming. Ongoing sat below Upcoming until issue 367, which put the
 * event people are following under a list of events that have not started.
 *
 * The fourth, the finished and abandoned, folds away behind a disclosure and is
 * rendered on its own below.
 */
const LIVE_GROUPS: [Exclude<ListGroup, "past">, MessageKey][] = [
  ["drafts", "tournaments.list.drafts"],
  ["ongoing", "tournaments.list.ongoing"],
  ["upcoming", "tournaments.list.upcoming"],
];

/** How many finished events a year of the archive draws before "show more". */
const ARCHIVE_PAGE = 50;

interface Props {
  /** The view's minute clock, in seconds, for the countdowns. */
  now: number;
  fold: EventListFold;
}

export function TournamentEventList({ now, fold }: Props) {
  const { t } = useTranslation();
  const events = useAppStore((store) => store.state.tourney.events);
  const selectedId = useAppStore((store) => store.state.tourney.selectedId);
  const { showPast, setShowPast, pastShown, setPastShown } = fold;

  const groups = groupedEvents(events);

  /**
   * One row of the list.
   *
   * The badge is the event's status, except where the status is not the whole
   * truth. An event whose signups have not opened yet still says `signup`, and
   * saying "Signups open" over a date three weeks out is the client telling
   * somebody to go and enter something they cannot enter. An abandoned one says
   * `signup` or `running` too, and is neither.
   */
  const row = (event: Tourney) => {
    // The website's three countdowns, in its precedence: signups opening, else
    // the event starting; signups closing rides beside the status rather than
    // replacing it, because "Signups open" is still the news.
    const countdowns = listCountdowns(event, now);
    const untilSignups = countdownTo(countdowns.signupsOpen, now);
    const untilStart = countdownTo(countdowns.eventStarts, now);
    const untilClose = countdownTo(countdowns.signupsClose, now);
    const pill = statusPill(event, now);
    const days = eventDayCount(event.eventDays);
    const ratingLine = listRatingLine(event, t);
    const teamsLine = listTeamsLine(event, t);
    const prize = formatPrize(event.prize);
    const facts = [
      listKind(event),
      ...(event.imported ? [] : [t("tournaments.list.signedUp", { count: event.playerCount })]),
      ...(ratingLine === "" ? [] : [ratingLine]),
      ...(teamsLine === "" ? [] : [teamsLine]),
    ];
    return (
      <li key={event.id}>
        <button
          type="button"
          className={
            event.id === selectedId
              ? "surface surface-interactive tournament-row is-active"
              : "surface surface-interactive tournament-row"
          }
          aria-current={event.id === selectedId}
          onClick={() => send({ type: "select", payload: { tournamentId: event.id } })}
        >
          {/* No "you are entered" badge here, however useful it would be.
              `GET /api/tournaments` sends no viewer block, so the answer is
              known only for whichever event happens to be open, and a badge
              that appears on a row the moment you click it reads as the client
              having just signed you up. A wrong answer about your own entry is
              worse than none. */}
          <span className="tournament-row-name">{event.name || t("tournaments.untitled")}</span>
          {/* Official or community, on the row rather than only inside. It is
              the first thing a player wants to know about an event they have
              not heard of: an official one is run by the tournament team under
              FAF's own rules and pays from FAF's fund. The service sends it with
              the list, so this costs nothing. */}
          {/* One line for both marks: what the event is, then where it is up
              to. Stacked they made every row three lines tall. */}
          <span className="tournament-row-marks">
            <span className={`tournament-tag is-${event.category}`}>
              {t(
                event.category === "official"
                  ? "tournaments.list.official"
                  : "tournaments.list.community",
              )}
            </span>
            {/* A draft says so, and a director looking at somebody else's
                says that too: they can open it, not run it. */}
            {!event.published && (
              <span
                className="tournament-badge"
                title={t(event.canManage ? "tournaments.list.draftTitle" : "tournaments.list.viewOnlyTitle")}
              >
                {t(event.canManage ? "tournaments.list.draftBadge" : "tournaments.list.viewOnly")}
              </span>
            )}
            {untilClose !== null && (
              <span className="tournament-countdown is-close">
                {t("tournaments.list.closesIn", { time: untilClose })}
              </span>
            )}
            {untilClose === null && untilSignups !== null ? (
              <span className="tournament-countdown">{t("tournaments.list.signupsIn", { time: untilSignups })}</span>
            ) : untilClose === null && untilStart !== null ? (
              <span className="tournament-countdown">{t("tournaments.list.startsIn", { time: untilStart })}</span>
            ) : (
              <span className={`tournament-badge is-${pill.tone}`}>{t(pill.label)}</span>
            )}
          </span>
          <span className="tournament-row-when muted">
            {formatDay(event.eventDate, t("tournaments.noDate"))}
            {days > 0 && (
              <>
                {" · "}
                <span className="tournament-days" title={eventDaysLabel(event.eventDays)}>
                  {t("tournaments.list.dayCount", { count: days })}
                </span>
              </>
            )}
            {prize !== "" && (
              <>
                {" · "}
                <span className="tournament-row-prize">{prize}</span>
              </>
            )}
          </span>
          <span className="tournament-row-when muted">{facts.join(" · ")}</span>
        </button>
      </li>
    );
  };

  return (
    <div className="tournaments-list">
      {events.length === 0 && (
        <div className="surface tournaments-state muted">{t("tournaments.loading")}</div>
      )}
      {LIVE_GROUPS.map(([group, heading]) =>
        groups[group].length === 0 ? null : (
          <section className="tournaments-group" key={group}>
            <h3>
              {t(heading)} <span className="muted">({groups[group].length})</span>
            </h3>
            <ul>{groups[group].map(row)}</ul>
          </section>
        ),
      )}

      {/* The archive, folded. Every event FAF has ever run is in this
          list, and the finished ones outnumber the live ones by an order
          of magnitude within a season: unfolded, they are a scroll with
          the useful part off the top of it. Kept rather than filtered
          out, because an organiser reruns a series by reading last
          year's, and that is a real thing people do here. */}
      {groups.past.length > 0 && (
        <section className="tournaments-group">
          <button
            type="button"
            className="tournaments-archive-toggle"
            aria-expanded={showPast}
            onClick={() => setShowPast((open) => !open)}
          >
            <Icon name={showPast ? "chevronDown" : "chevronRight"} size={14} />
            <span>{t("tournaments.list.past")}</span>
            <span className="muted">({groups.past.length})</span>
          </button>
          {/* By the year it was played, newest first, and fifty at a
              time within a year: years of imported events are thousands
              of rows, and nobody scrolls through those. */}
          {showPast &&
            archiveByYear(groups.past).map(({ year, events }) => {
              const key = year ?? 0;
              const shown = pastShown[key] ?? ARCHIVE_PAGE;
              const left = events.length - shown;
              return (
                <div className="tournaments-archive-year" key={key}>
                  <h4>
                    {year ?? t("tournaments.list.noYear")} <span className="muted">({events.length})</span>
                  </h4>
                  <ul>{events.slice(0, shown).map(row)}</ul>
                  {left > 0 && (
                    <Button
                      onClick={() => setPastShown((held) => ({ ...held, [key]: shown + ARCHIVE_PAGE }))}
                    >
                      {t("tournaments.list.showMore", {
                        count: Math.min(left, ARCHIVE_PAGE),
                        total: events.length,
                      })}
                    </Button>
                  )}
                </div>
              );
            })}
        </section>
      )}
    </div>
  );
}
