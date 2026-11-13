// The Statistics tab's Activity part (issue 748): when, how long and in which
// queue a player played. Everything is read off the scan the rest of the tab
// already holds; see `faf_domain::state::player_activity`.

import { useMemo, useState } from "react";
import type { PlayerActivity, PlayerMapStats, PlayerReport } from "../../ipc/bindings";
import { FactionIcon } from "../../shared/components/FactionIcon";
import { FACTION_COLORS, factionLabel } from "../../shared/factions";
import { formatDate } from "../../shared/format/dates";
import { leaderboardLabel } from "../../shared/playerRatings";
import { formatDecimal, getLocale, intlTag } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import {
  activityQueueColor,
  busiestMonth,
  daysBetween,
  hourStep,
  localWeek,
  monthBars,
  OTHER_QUEUE,
  playedHours,
  queuesIn,
  yearBars,
  type ActivityBar,
  type ActivityQueue,
} from "./playerActivity";
import { StatTiles, TabCard, type StatTile } from "./StatParts";

const EMPTY_ACTIVITY: PlayerActivity = { months: [], weekMinutes: [], factions: [], milestones: [] };

function monthLabel(period: string): string {
  return formatDate(`${period}-01T12:00:00Z`, period, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "Jan 26" under a month's bar, the year alone under a year's. */
function barLabel(period: string): string {
  return period.length === 4
    ? period
    : formatDate(`${period}-01T12:00:00Z`, period, { month: "short", year: "2-digit", timeZone: "UTC" });
}

function queueName(queue: ActivityQueue, other: string): string {
  return queue === OTHER_QUEUE ? other : leaderboardLabel(queue);
}

/** The months from the current one back eleven, as `YYYY-MM`. */
function lastTwelveMonths(now: Date): Set<string> {
  const months = new Set<string>();
  for (let back = 0; back < 12; back += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.add(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

export function PlayerActivityView({ stats, report, full, registeredAt }: {
  stats: PlayerMapStats;
  report: PlayerReport;
  /** Whether the whole history was asked for: milestones mean nothing on part of it. */
  full: boolean;
  registeredAt: string;
}) {
  const { t } = useTranslation();
  const activity = report.activity ?? EMPTY_ACTIVITY;
  const busiest = busiestMonth(activity.months);
  const recent = useMemo(() => {
    const months = lastTwelveMonths(new Date());
    return activity.months.filter((month) => months.has(month.period)).reduce((sum, month) => sum + month.minutes, 0);
  }, [activity.months]);
  const firstGame = activity.milestones.find((milestone) => milestone.games === 1)?.reached ?? "";

  const cards: StatTile[] = [
    { label: t("playerCard.stats.timePlayed"), value: t("playerCard.stats.hours", { hours: playedHours(report.playedMinutes ?? 0) }) },
    { label: t("playerCard.activity.lastYear"), value: t("playerCard.stats.hours", { hours: playedHours(recent) }) },
    { label: t("playerCard.activity.perWeek"), value: t("playerCard.stats.hours", { hours: playedHours(recent / 52) }) },
    {
      label: t("playerCard.activity.busiestMonth"),
      value: busiest ? monthLabel(busiest.period) : "–",
      detail: busiest ? t("playerCard.stats.hours", { hours: playedHours(busiest.minutes) }) : undefined,
    },
    { label: t("playerCard.activity.firstGame"), value: formatDate(firstGame, "–"), empty: firstGame === "" },
  ];

  return (
    <div className="player-statistics">
      <StatTiles columns={5} tiles={cards} />

      <HoursChart activity={activity} />

      <div className="player-statistics-grid is-pair">
        <WeekHeatmap weekMinutes={activity.weekMinutes} />
        <FactionTime activity={activity} />
      </div>

      <TabCard title={t("playerCard.activity.milestonesTitle")} className="player-stats-chart">
        {!full || stats.truncated ? (
          <p className="player-tab-card-empty muted">{t("playerCard.activity.milestonesNeedFull")}</p>
        ) : (
          // A timeline: a dot per milestone on one line, the count over the
          // day it was reached and how long after registering that was.
          <ol className="player-activity-milestones">
            {activity.milestones.map((milestone) => {
              const days = daysBetween(registeredAt, milestone.reached);
              return (
                <li key={milestone.games}>
                  <span className="player-activity-milestone-count">
                    {milestone.games === 1
                      ? t("playerCard.activity.milestoneFirst")
                      : t("playerCard.activity.milestoneGames", { count: milestone.games })}
                  </span>
                  <strong>{formatDate(milestone.reached)}</strong>
                  {days !== null && (
                    <span className="muted">{t("playerCard.activity.afterRegistering", { count: days })}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </TabCard>
    </div>
  );
}

/** Where the tooltip of bar `index` of `count` hangs: off its middle, or off a side near an edge. */
function tooltipEdge(index: number, count: number): string {
  const at = (index + 0.5) / count;
  return at < 0.2 ? " is-start" : at > 0.8 ? " is-end" : "";
}

/** Hours per month or year, stacked by queue. */
function HoursChart({ activity }: { activity: PlayerActivity }) {
  const { t } = useTranslation();
  const [scale, setScale] = useState<"months" | "years">("months");
  const [hovered, setHovered] = useState<number | null>(null);
  const bars = useMemo(
    () => (scale === "months" ? monthBars(activity.months) : yearBars(activity.months)),
    [activity.months, scale],
  );
  const legend = queuesIn(bars);
  const other = t("playerCard.activity.otherQueue");
  const maxHours = Math.max(0, ...bars.map((entry) => entry.minutes / 60));
  const step = hourStep(maxHours);
  const top = Math.max(step, Math.ceil(maxHours / step) * step);
  const lines = Array.from({ length: Math.floor(top / step) + 1 }, (_, index) => index * step);
  // A label under every bar would overlap at 24 months; every few bars instead.
  const labelEvery = Math.max(1, Math.ceil(bars.length / 12));
  const shown: ActivityBar | null = hovered === null ? null : bars[hovered] ?? null;

  return (
    <TabCard
      title={t("playerCard.activity.hoursTitle")}
      className="player-stats-chart"
      actions={
        <div className="settings-segmented player-tab-segmented" role="group" aria-label={t("playerCard.activity.scaleAria")}>
          {(["months", "years"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={scale === option ? "is-active" : undefined}
              aria-pressed={scale === option}
              onClick={() => {
                setScale(option);
                setHovered(null);
              }}
            >
              {t(option === "months" ? "playerCard.activity.byMonth" : "playerCard.activity.byYear")}
            </button>
          ))}
        </div>
      }
    >
      {bars.length === 0 ? (
        <p className="muted">{t("playerCard.maps.empty")}</p>
      ) : (
        <>
          {legend.length > 1 && (
            <ul className="player-activity-legend">
              {legend.map((queue) => (
                <li key={queue}>
                  <span className="player-activity-swatch" style={{ background: activityQueueColor(queue) }} />
                  {queueName(queue, other)}
                </li>
              ))}
            </ul>
          )}
          <div className="player-activity-chart" onMouseLeave={() => setHovered(null)}>
            <div className="player-activity-gridlines" aria-hidden="true">
              {lines.map((value) => (
                <span key={value} style={{ bottom: `${(value / top) * 100}%` }}>
                  <em>{t("playerCard.stats.hours", { hours: value })}</em>
                </span>
              ))}
            </div>
            <div className="player-activity-bars">
              {bars.map((entry, index) => (
                <div
                  key={entry.period}
                  className={hovered === index ? "player-activity-bar is-hovered" : "player-activity-bar"}
                  tabIndex={0}
                  aria-label={`${scale === "months" ? monthLabel(entry.period) : entry.period}: ${t("playerCard.activity.barTooltip", {
                    hours: playedHours(entry.minutes),
                    count: entry.games,
                  })}`}
                  onMouseEnter={() => setHovered(index)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(null)}
                >
                  <div className="player-activity-stack" style={{ height: `${(entry.minutes / 60 / top) * 100}%` }}>
                    {entry.queues.map((part) => (
                      <span
                        key={part.queue}
                        style={{ flexGrow: part.minutes, background: activityQueueColor(part.queue) }}
                      />
                    ))}
                  </div>
                  <small aria-hidden="true">{(bars.length - 1 - index) % labelEvery === 0 ? barLabel(entry.period) : ""}</small>
                </div>
              ))}
              {shown && hovered !== null && (
                <div
                  className={`player-activity-tooltip surface${tooltipEdge(hovered, bars.length)}`}
                  role="status"
                  style={{ left: `${((hovered + 0.5) / bars.length) * 100}%` }}
                >
                  <strong>{scale === "months" ? monthLabel(shown.period) : shown.period}</strong>
                  <span>{t("playerCard.activity.barTooltip", { hours: playedHours(shown.minutes), count: shown.games })}</span>
                  {[...shown.queues].reverse().map((part) => (
                    <span key={part.queue} className="player-activity-tooltip-row">
                      <span className="player-activity-swatch" style={{ background: activityQueueColor(part.queue) }} />
                      {queueName(part.queue, other)}
                      <em>{t("playerCard.stats.hours", { hours: playedHours(part.minutes) })}</em>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </TabCard>
  );
}

/** Weekday names in the reader's language, Monday first. */
function weekdayNames(): string[] {
  const format = new Intl.DateTimeFormat(intlTag(getLocale()), { weekday: "short", timeZone: "UTC" });
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, day) => format.format(new Date(Date.UTC(2024, 0, 1 + day))));
}

/** Hours played by weekday and hour of day, in the reader's time zone. */
function WeekHeatmap({ weekMinutes }: { weekMinutes: number[] }) {
  const { t } = useTranslation();
  const week = useMemo(() => localWeek(weekMinutes, -new Date().getTimezoneOffset()), [weekMinutes]);
  const max = Math.max(0, ...week);
  const days = weekdayNames();
  return (
    <TabCard title={t("playerCard.activity.weekTitle")} className="player-stats-chart">
      <div className="player-activity-week" role="table" aria-label={t("playerCard.activity.weekTitle")}>
        {days.map((day, row) => (
          <div key={day} className="player-activity-week-row" role="row">
            <span role="rowheader">{day}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const minutes = week[row * 24 + hour];
              // One hue, light to strong: the share of the busiest hour.
              const share = max > 0 && minutes > 0 ? 15 + Math.round((minutes / max) * 85) : 0;
              const label = t("playerCard.activity.cellTooltip", {
                day,
                from: String(hour).padStart(2, "0"),
                to: String((hour + 1) % 24).padStart(2, "0"),
                hours: playedHours(minutes),
              });
              return (
                <span
                  key={hour}
                  role="cell"
                  className="player-activity-cell"
                  title={label}
                  aria-label={label}
                  style={share > 0 ? { background: `color-mix(in srgb, var(--color-chart-1) ${share}%, var(--color-surface-raised))` } : undefined}
                />
              );
            })}
          </div>
        ))}
        <div className="player-activity-week-row player-activity-week-hours" aria-hidden="true">
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <small key={hour}>{hour % 6 === 0 ? String(hour).padStart(2, "0") : ""}</small>
          ))}
        </div>
      </div>
      <p className="muted player-stats-insight-note">{t("playerCard.activity.weekNote")}</p>
    </TabCard>
  );
}

/** Time played per faction, as a share of all the time with a known faction. */
function FactionTime({ activity }: { activity: PlayerActivity }) {
  const { t } = useTranslation();
  const total = activity.factions.reduce((sum, row) => sum + row.minutes, 0);
  return (
    <TabCard title={t("playerCard.activity.factionsTitle")} className="player-stats-chart">
      {total === 0 ? (
        <p className="muted">{t("playerCard.maps.empty")}</p>
      ) : (
        <ul className="player-activity-factions">
          {activity.factions.map((row) => {
            const share = (row.minutes / total) * 100;
            return (
              <li key={row.faction}>
                <span className="player-stats-faction">
                  <FactionIcon faction={row.faction} size={16} aria-hidden="true" role="presentation" />
                  {factionLabel(row.faction)}
                </span>
                <span className="player-activity-track" aria-hidden="true">
                  <span style={{ width: `${share}%`, background: FACTION_COLORS[row.faction] ?? "var(--color-muted)" }} />
                </span>
                <span className="player-activity-faction-value">
                  {t("playerCard.stats.hours", { hours: playedHours(row.minutes) })}
                  <span className="muted"> · {formatDecimal(share)}%</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </TabCard>
  );
}
