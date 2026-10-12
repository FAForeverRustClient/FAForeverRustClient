// The event list: drafts, ongoing and upcoming events, then the archive folded
// away by year.

import type { ReactNode } from "react";
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
  listRatingParts,
  listTeamsLine,
  signupProgress,
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
 *
 * The drafts carry no heading: every one of them says "Draft" on its own card,
 * and without a heading the first card starts level with the detail pane.
 */
const LIVE_GROUPS: [Exclude<ListGroup, "past">, MessageKey | null][] = [
  ["drafts", null],
  ["ongoing", "tournaments.list.ongoing"],
  ["upcoming", "tournaments.list.upcoming"],
];

/** How many finished events a year of the archive draws before "show more". */
const ARCHIVE_PAGE = 50;

/**
 * Facts in a line, a dot between each. A fact never breaks inside itself, and
 * the dot in front of one that wraps to a new line is hidden off the leading
 * edge rather than left to start the line.
 */
function FactLine({ facts, quiet = false }: { facts: ReactNode[]; quiet?: boolean }) {
  if (facts.length === 0) return null;
  return (
    <span className={quiet ? "tournament-row-facts is-quiet" : "tournament-row-facts"}>
      <span>
        {facts.map((fact, index) => (
          <span className="tournament-row-fact" key={index}>
            {fact}
          </span>
        ))}
      </span>
    </span>
  );
}

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
   * One row of the list, as a card: the tags, the name, when and for whom
   * beside the prize, and a footer with where it is up to.
   *
   * The status is the event's, except where the status is not the whole
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
    const progress = signupProgress(event, now);
    const pill = statusPill(event, now);
    const days = eventDayCount(event.eventDays);
    const rating = listRatingParts(event, t);
    const teamsLine = listTeamsLine(event, t);
    const prize = formatPrize(event.prize);
    // The field, then its rating gate on a line of its own: together they are
    // four facts, which wrap in a column this wide.
    const facts = [
      ...(event.imported ? [] : [t("tournaments.list.signedUp", { count: event.playerCount })]),
      ...(teamsLine === "" ? [] : [teamsLine]),
    ];
    // The status, or the countdown that is the news instead, in the status's
    // own colour.
    const statusText =
      untilClose === null && untilSignups !== null
        ? t("tournaments.list.signupsIn", { time: untilSignups })
        : untilClose === null && untilStart !== null
          ? t("tournaments.list.startsIn", { time: untilStart })
          : t(pill.label);
    return (
      <li key={event.id}>
        <button
          type="button"
          className={[
            "tournament-row",
            `is-series-${event.seriesColour}`,
            event.id === selectedId ? "is-active" : "",
          ]
            .filter((name) => name !== "")
            .join(" ")}
          aria-current={event.id === selectedId}
          onClick={() => send({ type: "select", payload: { tournamentId: event.id } })}
        >
          {/* No "you are entered" badge here, however useful it would be.
              `GET /api/tournaments` sends no viewer block, so the answer is
              known only for whichever event happens to be open, and a badge
              that appears on a row the moment you click it reads as the client
              having just signed you up. A wrong answer about your own entry is
              worse than none. */}
          {/* Official or community first: it is the first thing a player wants
              to know about an event they have not heard of. An official one is
              run by the tournament team under FAF's own rules and pays from
              FAF's fund. Then the kind, then a draft's own mark. */}
          <span className="tournament-row-tags">
            <span className={`tournament-row-tag is-${event.category}`}>
              {t(
                event.category === "official"
                  ? "tournaments.list.official"
                  : "tournaments.list.community",
              )}
            </span>
            <span className="tournament-row-tag">{listKind(event)}</span>
            {/* A draft says so, and a director looking at somebody else's
                says that too: they can open it, not run it. */}
            {!event.published && (
              <span
                className="tournament-row-tag"
                title={t(event.canManage ? "tournaments.list.draftTitle" : "tournaments.list.viewOnlyTitle")}
              >
                {t(event.canManage ? "tournaments.list.draftBadge" : "tournaments.list.viewOnly")}
              </span>
            )}
          </span>
          <span className="tournament-row-name">{event.name || t("tournaments.untitled")}</span>
          <span className="tournament-row-body">
            <span className="tournament-row-info">
              <FactLine
                facts={[
                  formatDay(event.eventDate, t("tournaments.noDate")),
                  ...(days > 0
                    ? [
                        <span className="tournament-days" title={eventDaysLabel(event.eventDays)}>
                          {t("tournaments.list.dayCount", { count: days })}
                        </span>,
                      ]
                    : []),
                ]}
              />
              <FactLine facts={facts} quiet />
              <FactLine facts={rating} quiet />
            </span>
            {prize !== "" && <span className="tournament-row-prize">{prize}</span>}
          </span>
          <span className="tournament-row-foot">
            <span className={`tournament-status is-${pill.tone}`}>{statusText}</span>
            {untilClose !== null && (
              <span className="tournament-row-closing">
                <span>{t("tournaments.list.closesIn", { time: untilClose })}</span>
                {progress !== null && (
                  <span className="tournament-row-progress" aria-hidden="true">
                    <span style={{ width: `${Math.round(progress * 100)}%` }} />
                  </span>
                )}
              </span>
            )}
          </span>
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
            {heading !== null && (
              <h3>
                <span>{t(heading)}</span>
                <span className="tournaments-group-count">{groups[group].length}</span>
              </h3>
            )}
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
            <span className="tournaments-group-count">{groups.past.length}</span>
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
                    <span>{year ?? t("tournaments.list.noYear")}</span>
                    <span className="tournaments-group-count">{events.length}</span>
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
