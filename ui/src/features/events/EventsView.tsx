// The Events tab: what is happening in FAF, and when.
//
// Three sources on one calendar. Tournaments and released patches are already
// in the client and are read out of state; everything a person has to know
// (CGN, meetups, a club's game night, the next patch's date) comes from the
// community catalogue this tab's slice fetches. `calendarFeed` does the merge
// and `calendarGrid` the arithmetic; this file is the chrome around them.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { SectionTabs, type SectionTab } from "../../design-system/SectionTabs";
import { Select } from "../../design-system/Select";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import type { CalendarView, EventCategory, EventsQuery } from "../../ipc/bindings";
import { buildFeed, entriesByDay, filterFeed, type CalendarEntry } from "./calendarFeed";
import { addDays, addMonths, isoDay, resolveAnchor, viewWindow } from "./calendarGrid";
import { EventDetail } from "./EventDetail";
import { EventSubmitDialog } from "./EventSubmitDialog";
import { EventMonth } from "./EventMonth";
import { EventUpcoming } from "./EventUpcoming";
import { EventWeek } from "./EventWeek";
import { CATEGORIES, categoryLabel, monthTitle, weekTitle } from "./eventPresentation";
import "./events.css";

const setView = (view: CalendarView) =>
  ipc.send({ kind: "Events", command: { type: "setView", payload: { view } } });
const setAnchor = (day: string) =>
  ipc.send({ kind: "Events", command: { type: "setAnchor", payload: { day } } });
const setQuery = (query: EventsQuery) =>
  ipc.send({ kind: "Events", command: { type: "setQuery", payload: { query } } });
const select = (occurrenceId: string | null) =>
  ipc.send({ kind: "Events", command: { type: "select", payload: { occurrenceId } } });

/**
 * How often the clock the view is drawn against is re-read.
 *
 * Only "today" and whether an entry has passed depend on it, so a minute is far
 * more often than it needs to be and still costs one re-render.
 */
const CLOCK_TICK_MS = 60_000;

export function EventsView() {
  const { t } = useTranslation();
  const events = useAppStore((state) => state.state.events);
  const tourneys = useAppStore((state) => state.state.tourney.events);
  const releases = useAppStore((state) => state.state.changelog.releases);
  const preferences = useAppStore((state) => state.state.settings.events);

  // The wall clock as component state, so the grid's "today" moves at midnight
  // in a client that is left open. Not in the slice: nothing in the backend has
  // an opinion about what minute the view was drawn in.
  const [now, setNow] = useState(() => new Date());
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    ipc.send({ kind: "Events", command: { type: "load" } });
  }, []);

  const weekStart = preferences.weekStart;
  const anchor = useMemo(() => resolveAnchor(events.anchor, now), [events.anchor, now]);
  const reminded = useMemo(
    () => new Set(preferences.reminders.map((reminder) => reminder.occurrenceId)),
    [preferences.reminders],
  );

  const entries = useMemo(() => {
    const { from, to } = viewWindow(events.view, anchor, weekStart, now);
    return filterFeed(
      buildFeed({ catalogue: events.catalogue, tourneys, releases, from, to }),
      events.query,
      reminded,
    );
  }, [anchor, events.catalogue, events.query, events.view, now, releases, reminded, tourneys, weekStart]);

  const byDay = useMemo(() => entriesByDay(entries), [entries]);

  // The open occurrence is usually one of the entries on screen. It is not when
  // a reminder opened it: a notification can name a game night five weeks from
  // the month the tab was left on, and a filter that happens to be set would
  // hide it too. So the lookup falls back to a wide window with no filters,
  // which is what makes the notification's "open the calendar" always land on
  // something.
  const open = useMemo(() => {
    if (!events.selected) return null;
    const onScreen = entries.find((entry) => entry.id === events.selected);
    if (onScreen) return onScreen;
    const seconds = Math.floor(now.getTime() / 1000);
    return (
      buildFeed({
        catalogue: events.catalogue,
        tourneys,
        releases,
        from: seconds - 31 * 24 * 60 * 60,
        to: seconds + 366 * 24 * 60 * 60,
      }).find((entry) => entry.id === events.selected) ?? null
    );
  }, [entries, events.catalogue, events.selected, now, releases, tourneys]);
  const openLead =
    open === null
      ? null
      : preferences.reminders.find((reminder) => reminder.occurrenceId === open.id)?.leadMinutes ??
        null;

  const step = (direction: -1 | 1) => {
    const moved =
      events.view === "month" ? addMonths(anchor, direction) : addDays(anchor, direction * 7);
    setAnchor(isoDay(moved));
  };

  const views: SectionTab<CalendarView>[] = [
    { id: "upcoming", label: t("events.view.upcoming") },
    { id: "month", label: t("events.view.month") },
    { id: "week", label: t("events.view.week") },
  ];

  const title =
    events.view === "month"
      ? monthTitle(anchor)
      : events.view === "week"
        ? weekTitle(anchor, weekStart)
        : t("events.view.upcoming");

  const patch = (change: Partial<EventsQuery>) => setQuery({ ...events.query, ...change });

  return (
    <div className="events-view">
      <header className="events-head">
        <div className="events-head-copy">
          <h2 className="view-title">{t("events.title")}</h2>
          <p>{t("events.subtitle")}</p>
        </div>
        {/* Only when the catalogue was read from the network: the copy that
            ships with the client names no submission address, because it is
            shown precisely when that address cannot be relied on. */}
        {events.submitUrl && (
          <Button onClick={() => setSubmitting(true)}>
            <Icon name="plus" size={14} /> {t("events.suggest")}
          </Button>
        )}
      </header>

      <div className="events-toolbar">
        <SectionTabs
          active={events.view}
          ariaLabel={t("events.view.aria")}
          className="events-view-tabs"
          items={views}
          onChange={setView}
        />
        {events.view !== "upcoming" && (
          <div className="events-period" role="group" aria-label={t("events.period.aria")}>
            <button type="button" onClick={() => step(-1)} aria-label={t("events.period.previous")}>
              <Icon name="arrowLeft" size={15} />
            </button>
            <strong>{title}</strong>
            <button type="button" onClick={() => step(1)} aria-label={t("events.period.next")}>
              <Icon name="arrowRight" size={15} />
            </button>
            <Button onClick={() => setAnchor("")}>{t("events.period.today")}</Button>
          </div>
        )}
      </div>

      <div className="events-filters">
        <label className="events-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={events.query.text}
            placeholder={t("events.filter.search")}
            aria-label={t("events.filter.search")}
            onChange={(change) => patch({ text: change.target.value })}
          />
        </label>
        <Select<EventCategory | "">
          className="events-category-select"
          label={t("events.filter.category")}
          value={events.query.category ?? ""}
          options={[
            { value: "", label: t("events.filter.allCategories") },
            ...CATEGORIES.map((category) => ({
              value: category,
              label: t(categoryLabel(category)),
            })),
          ]}
          onChange={(category) => patch({ category: category === "" ? null : category })}
        />
        <button
          type="button"
          className={events.query.origin === "official" ? "events-chip is-on" : "events-chip"}
          aria-pressed={events.query.origin === "official"}
          onClick={() => patch({ origin: events.query.origin === "official" ? null : "official" })}
        >
          {t("events.origin.official")}
        </button>
        <button
          type="button"
          className={events.query.origin === "community" ? "events-chip is-on" : "events-chip"}
          aria-pressed={events.query.origin === "community"}
          onClick={() => patch({ origin: events.query.origin === "community" ? null : "community" })}
        >
          {t("events.origin.community")}
        </button>
        <button
          type="button"
          className={events.query.onlyReminders ? "events-chip is-on" : "events-chip"}
          aria-pressed={events.query.onlyReminders}
          onClick={() => patch({ onlyReminders: !events.query.onlyReminders })}
        >
          <Icon name="bell" size={12} /> {t("events.filter.mine")}
        </button>
      </div>

      {events.status.type === "failed" && (
        <p className="events-notice" role="status">
          {t("events.failed", { reason: events.status.payload.reason })}
        </p>
      )}

      {events.view === "month" && (
        <EventMonth
          anchor={anchor}
          now={now}
          weekStart={weekStart}
          byDay={byDay}
          reminded={reminded}
          onOpen={(entry: CalendarEntry) => select(entry.id)}
          onOpenDay={(day) => {
            setAnchor(isoDay(day));
            setView("week");
          }}
        />
      )}
      {events.view === "week" && (
        <EventWeek
          anchor={anchor}
          now={now}
          weekStart={weekStart}
          byDay={byDay}
          reminded={reminded}
          onOpen={(entry: CalendarEntry) => select(entry.id)}
        />
      )}
      {events.view === "upcoming" && (
        <EventUpcoming
          entries={entries}
          now={now}
          reminded={reminded}
          onOpen={(entry: CalendarEntry) => select(entry.id)}
        />
      )}

      {/* Under the calendar rather than over it: the bundled catalogue is not a
          failure, and saying so where it is read is better than a banner. */}
      {events.source === "bundled" && events.status.type !== "failed" && (
        <p className="events-notice muted" role="status">
          {t("events.bundled")}
        </p>
      )}

      {entries.length === 0 && events.view !== "upcoming" && (
        <EmptyState
          icon="calendar"
          title={t("events.emptyTitle")}
          hint={events.query.text || events.query.category || events.query.origin || events.query.onlyReminders
            ? t("events.emptyFiltered")
            : t("events.emptyHint")}
        />
      )}

      {open && (
        <EventDetail entry={open} leadMinutes={openLead} onClose={() => select(null)} />
      )}

      {submitting && (
        <EventSubmitDialog submitUrl={events.submitUrl} onClose={() => setSubmitting(false)} />
      )}
    </div>
  );
}
