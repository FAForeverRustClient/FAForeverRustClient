// The profile's Statistics tab: faftracker.xyz's player report, read off the
// same game-history scan as the Maps and Results tabs (issue 606).
//
// Only what the games themselves say. The tab used to chart the API's own
// counters as well (faction plays and wins from the achievement events, unit
// counts from the same events, and a leaderboard's `wonGames`), and those do
// not agree with the games behind them, so none of them is shown here any
// more. What the tracker shows that the profile already has elsewhere stays
// there: the rating trend on Ratings, the map tendencies on Maps, the game
// history on Results.

import { useMemo, useState, type ReactNode } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { PlayerCardProfile, PlayerPeriodStat, PlayerRelation, PlayerReport } from "../../ipc/bindings";
import { FactionIcon } from "../../shared/components/FactionIcon";
import { factionLabel } from "../../shared/factions";
import { formatDate } from "../../shared/format/dates";
import { openPlayerCard } from "../../shared/playerCardActions";
import { leaderboardLabel } from "../../shared/playerRatings";
import { useAppStore } from "../../store/store";
import { formatDecimal, formatNumber, getLocale, intlTag } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { HistoryFailure } from "./HistoryFailure";
import { HistoryScopeNote } from "./HistoryScopeNote";
import { leaderboardTotalGames, rankedRecord } from "./rankedRecord";
import { usePlayerHistory } from "./usePlayerHistory";

const EVENTS = {
  aeonPlays: "96ccc66a-c5a0-4f48-acaa-888b00778b57",
  aeonWins: "a6b51c26-64e6-4e7a-bda7-ea1cfe771ebb",
  cybranPlays: "ad193982-e7ca-465c-80b0-5493f9739559",
  cybranWins: "56b06197-1890-42d0-8b59-25e1add8dc9a",
  uefPlays: "1b900d26-90d2-43d0-a64e-ed90b74c3704",
  uefWins: "7be6fdc5-7867-4467-98ce-f7244a66625a",
  seraphimPlays: "fefcb392-848f-4836-9683-300b283bc308",
  seraphimWins: "15b6c19a-6084-4e82-ada9-6c30e282191f",
} as const;

// The number is the faction's id: its emblem and, through the catalog, its
// name.
const FACTIONS: Array<[number, string, string]> = [
  [2, EVENTS.aeonPlays, EVENTS.aeonWins],
  [3, EVENTS.cybranPlays, EVENTS.cybranWins],
  [1, EVENTS.uefPlays, EVENTS.uefWins],
  [4, EVENTS.seraphimPlays, EVENTS.seraphimWins],
];

export interface FactionRecord {
  /** The game's faction id: its emblem, colour and name. */
  faction: number;
  games: number;
  wins: number;
}

/**
 * Games and wins per faction, from the profile's event counters. The
 * overview's faction strip still reads these; the Statistics tab counts the
 * games instead.
 */
export function factionRecords(profile: PlayerCardProfile): FactionRecord[] {
  const counts = new Map(profile.events.map((event) => [event.eventId, event.count]));
  const count = (id: string) => counts.get(id) ?? 0;
  return FACTIONS.map(([faction, plays, wins]) => ({
    faction,
    games: count(plays),
    wins: Math.min(count(wins), count(plays)),
  }));
}

const NO_STREAK = { size: 0, first: "", last: "" };

/** A scan that carried no report: every figure empty. */
const EMPTY_REPORT: PlayerReport = {
  ratedGames: 0,
  recentWins: 0,
  recentDecided: 0,
  averageMinutesTenths: 0,
  maxWinStreak: NO_STREAK,
  maxLossStreak: NO_STREAK,
  worstLossStreak: 0,
  months: [],
  bestMonths: [],
  worstMonths: [],
  bestDays: [],
  worstDays: [],
  recentFrom: "",
  recentTo: "",
  mapsGaining: [],
  mapsLosing: [],
  runbacks: [],
  teammates: [],
  opponents: [],
  factions: [],
};

/** Wins out of wins and losses, in percent; `null` with neither. */
export function decidedRate(wins: number, losses: number): number | null {
  return wins + losses > 0 ? (wins / (wins + losses)) * 100 : null;
}

/** Hundredths of a rating point, signed, to two decimals as the tracker prints them. */
export function signedRating(hundredths: number): string {
  const value = hundredths / 100;
  const text = new Intl.NumberFormat(intlTag(getLocale()), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return value > 0 ? `+${text}` : value < 0 ? `-${text}` : text;
}

function percent(value: number | null): string {
  return value === null ? "–" : `${formatDecimal(value)}%`;
}

function monthLabel(period: string): string {
  return formatDate(`${period}-01T12:00:00Z`, period, { month: "short", year: "numeric", timeZone: "UTC" });
}

function dayLabel(period: string): string {
  return formatDate(`${period}T12:00:00Z`, period);
}

/** One column of a statistics table: its heading, what it sorts by, what it shows. */
export interface StatsColumn<T> {
  label: string;
  /** The value the column sorts by: a number, or text for a name column. */
  sortValue: (row: T) => number | string;
  render: (row: T) => ReactNode;
}

type SortState = { column: number; descending: boolean } | null;

/**
 * `rows` in the order the clicked column asks for, or as given while no column
 * is chosen. Numbers sort high to low on the first click and text A to Z, the
 * way each is read best-first; a second click on the same column reverses it.
 * Ties keep their given order.
 */
export function sortRows<T>(rows: readonly T[], columns: readonly StatsColumn<T>[], sort: SortState): T[] {
  if (sort === null) return [...rows];
  const key = columns[sort.column].sortValue;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = key(a.row);
      const right = key(b.row);
      const order = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right));
      return (sort.descending ? -order : order) || a.index - b.index;
    })
    .map(({ row }) => row);
}

/** The direction a column sorts in on its first click. */
function firstDescending<T>(column: StatsColumn<T>, rows: readonly T[]): boolean {
  return rows.length > 0 && typeof column.sortValue(rows[0]) === "number";
}

/**
 * A table with a name column that takes the slack and figures after it, and
 * every column sortable by a click on its heading. `limit` shows only the
 * first rows of the sorted whole, for the long teammate and opponent lists.
 */
function StatsTable<T>({ columns, rows, limit }: { columns: StatsColumn<T>[]; rows: readonly T[]; limit?: number }) {
  const [sort, setSort] = useState<SortState>(null);
  const sorted = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  const shown = limit === undefined ? sorted : sorted.slice(0, limit);
  const toggle = (column: number) =>
    setSort((current) =>
      current?.column === column
        ? { column, descending: !current.descending }
        : { column, descending: firstDescending(columns[column], rows) },
    );
  return (
    <div className="player-stats-table-wrap">
      <table className="player-stats-table">
        <thead>
          <tr>
            {columns.map((column, index) => {
              const active = sort?.column === index;
              return (
                <th
                  key={column.label}
                  className={active ? "is-sorted" : undefined}
                  aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}
                >
                  <button type="button" className="player-stats-sort" onClick={() => toggle(index)}>
                    {column.label}
                    <Icon name={active && !sort.descending ? "chevronUp" : "chevronDown"} size={11} />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => <td key={column.label}>{column.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlayerStatistics({ profile }: { profile: PlayerCardProfile }) {
  const { t } = useTranslation();
  const { stats, status, error, full, loadFull, retry } = usePlayerHistory(profile.playerId);
  const ratings = useAppStore((state) => state.state.playerCard.profile?.ratings);

  if (status === "failed") return <HistoryFailure error={error} onRetry={retry} />;
  if (!stats) {
    return <div className="player-card-empty player-card-tab-loading muted" role="status">{t("playerCard.maps.loading")}</div>;
  }
  if (stats.totalGames === 0) {
    return <div className="player-card-empty muted">{t("playerCard.maps.empty")}</div>;
  }

  const report = stats.report ?? EMPTY_REPORT;
  const summary = rankedRecord(stats, leaderboardTotalGames(ratings));
  const streakDetail = (first: string, last: string) =>
    first === ""
      ? t("playerCard.stats.noGames")
      : first.slice(0, 7) === last.slice(0, 7)
        ? monthLabel(first.slice(0, 7))
        : t("playerCard.stats.monthRange", { from: monthLabel(first.slice(0, 7)), to: monthLabel(last.slice(0, 7)) });

  const cards: Array<{ label: string; value: string; detail?: string }> = [
    { label: t("playerCard.stats.loadedGames"), value: formatNumber(stats.totalGames) },
    { label: t("playerCard.stats.rankedGames"), value: formatNumber(summary.rankedGames) },
    { label: t("playerCard.stats.unrankedGames"), value: formatNumber(summary.unrankedGames) },
    { label: t("playerCard.stats.draws"), value: formatNumber(summary.draws) },
    { label: t("playerCard.stats.rankedRecord"), value: `${formatNumber(summary.wins)}–${formatNumber(summary.losses)}` },
    { label: t("playerCard.stats.rankedWinRate"), value: percent(summary.winRate) },
    {
      label: t("playerCard.stats.recentWinRate"),
      value: percent(report.recentDecided > 0 ? (report.recentWins / report.recentDecided) * 100 : null),
    },
    {
      label: t("playerCard.stats.averageDuration"),
      value: t("playerCard.stats.minutes", { minutes: formatDecimal(report.averageMinutesTenths / 10) }),
    },
    {
      label: t("playerCard.stats.maxWinStreak"),
      value: report.maxWinStreak.size > 0
        ? t("playerCard.stats.winStreak", { count: report.maxWinStreak.size })
        : t("playerCard.stats.noWins"),
      detail: streakDetail(report.maxWinStreak.first, report.maxWinStreak.last),
    },
    {
      label: t("playerCard.stats.maxLossStreak"),
      value: report.maxLossStreak.size > 0
        ? t("playerCard.stats.lossStreak", { count: report.maxLossStreak.size })
        : t("playerCard.stats.noLosses"),
      detail: streakDetail(report.maxLossStreak.first, report.maxLossStreak.last),
    },
  ];

  return (
    <div className="player-statistics">
      <dl className="player-account-details player-stats-cards surface">
        {cards.map((card) => (
          <div key={card.label}>
            <dt>{card.label}</dt>
            <dd className="player-maps-value">{card.value}</dd>
            {card.detail && <dd className="player-maps-detail">{card.detail}</dd>}
          </div>
        ))}
      </dl>
      <HistoryScopeNote stats={stats} full={full} onLoadFull={loadFull} />

      <div className="player-statistics-grid">
        <section className="player-stats-chart surface-panel">
          <h3>{t("playerCard.stats.ratingGainTitle")}</h3>
          <StatsTable
            rows={stats.queues ?? []}
            columns={[
              { label: t("playerCard.stats.queue"), sortValue: (queue) => leaderboardLabel(queue.queue), render: (queue) => leaderboardLabel(queue.queue) },
              { label: t("playerCard.stats.games"), sortValue: (queue) => queue.games, render: (queue) => formatNumber(queue.games) },
              recordColumn(t("playerCard.stats.recordColumn")),
              rateColumn(t("playerCard.stats.winRate")),
              { label: t("playerCard.stats.total"), sortValue: (queue) => queue.ratingDeltaHundredths, render: (queue) => signedRating(queue.ratingDeltaHundredths) },
              {
                label: t("playerCard.stats.average"),
                sortValue: (queue) => queue.ratingDeltaHundredths / Math.max(queue.games, 1),
                render: (queue) => signedRating(Math.round(queue.ratingDeltaHundredths / Math.max(queue.games, 1))),
              },
            ]}
          />
        </section>

        <section className="player-stats-chart surface-panel">
          <h3>{t("playerCard.stats.monthlyTitle")}</h3>
          <StatsTable
            rows={[...report.months].reverse()}
            columns={[
              // By the period itself, `YYYY-MM`, which sorts as the calendar does.
              { label: t("playerCard.stats.month"), sortValue: (month) => month.period, render: (month) => monthLabel(month.period) },
              { label: t("playerCard.stats.games"), sortValue: (month) => month.games, render: (month) => formatNumber(month.games) },
              recordColumn(t("playerCard.stats.recordColumn")),
              rateColumn(t("playerCard.stats.winRate")),
              { label: t("playerCard.stats.rating"), sortValue: (month) => month.ratingDeltaHundredths, render: (month) => signedRating(month.ratingDeltaHundredths) },
            ]}
          />
        </section>

        <section className="player-stats-chart surface-panel">
          <h3>{t("playerCard.stats.factionsTitle")}</h3>
          <StatsTable
            rows={report.factions}
            columns={[
              {
                label: t("playerCard.stats.faction"),
                sortValue: (row) => factionLabel(row.faction),
                render: (row) => (
                  <span className="player-stats-faction">
                    <FactionIcon faction={row.faction} size={16} aria-hidden="true" role="presentation" />
                    {factionLabel(row.faction)}
                  </span>
                ),
              },
              { label: t("playerCard.stats.games"), sortValue: (row) => row.games, render: (row) => formatNumber(row.games) },
              recordColumn(t("playerCard.stats.recordColumn")),
              rateColumn(t("playerCard.stats.winRate")),
            ]}
          />
        </section>
      </div>

      <div className="player-statistics-grid is-pair">
        <RelationTable title={t("playerCard.stats.teammatesTitle")} column={t("playerCard.stats.teammate")} rows={report.teammates} />
        <RelationTable title={t("playerCard.stats.opponentsTitle")} column={t("playerCard.stats.opponent")} rows={report.opponents} />
      </div>

      <section className="player-stats-chart surface-panel">
        <h3>{t("playerCard.stats.improvementTitle")}</h3>
        <div className="player-stats-insights">
          <PeriodInsight
            title={t("playerCard.stats.bestMonths")}
            rows={report.bestMonths}
            label={monthLabel}
            empty={t("playerCard.stats.bestMonthsEmpty")}
          />
          <PeriodInsight
            title={t("playerCard.stats.worstMonths")}
            rows={report.worstMonths}
            label={monthLabel}
            empty={t("playerCard.stats.worstMonthsEmpty")}
            firstNote={report.worstLossStreak > 0 ? t("playerCard.stats.worstLossStreak", { count: report.worstLossStreak }) : undefined}
          />
          <PeriodInsight title={t("playerCard.stats.bestDays")} rows={report.bestDays} label={dayLabel} empty={t("playerCard.stats.bestDaysEmpty")} />
          <PeriodInsight title={t("playerCard.stats.worstDays")} rows={report.worstDays} label={dayLabel} empty={t("playerCard.stats.worstDaysEmpty")} />
          <MapInsight
            title={t("playerCard.stats.mapsGaining")}
            rows={report.mapsGaining}
            from={report.recentFrom}
            to={report.recentTo}
            empty={t("playerCard.stats.mapsGainingEmpty")}
          />
          <MapInsight
            title={t("playerCard.stats.mapsLosing")}
            rows={report.mapsLosing}
            from={report.recentFrom}
            to={report.recentTo}
            empty={t("playerCard.stats.mapsLosingEmpty")}
          />
          <article className="player-stats-insight">
            <h4>{t("playerCard.stats.runbacks")}</h4>
            {report.runbacks.length === 0 ? (
              <p className="muted">{t("playerCard.stats.runbacksEmpty")}</p>
            ) : (
              <>
                <ul>
                  {report.runbacks.map((row) => (
                    <li key={row.login}>
                      <strong>{row.login}</strong>
                      <span className="muted">
                        {t("playerCard.stats.runbackLine", {
                          early: percent((row.earlyWins / Math.max(row.earlyGames, 1)) * 100),
                          late: percent((row.lateWins / Math.max(row.lateGames, 1)) * 100),
                          count: row.lateGames,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="muted player-stats-insight-note">{t("playerCard.stats.runbacksNote")}</p>
              </>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}

interface Record3 {
  wins: number;
  losses: number;
  draws: number;
}

/** W–L–D, sorted by the wins. */
function recordColumn<T extends Record3>(label: string): StatsColumn<T> {
  return {
    label,
    sortValue: (row) => row.wins,
    render: (row) => `${formatNumber(row.wins)}–${formatNumber(row.losses)}–${formatNumber(row.draws)}`,
  };
}

/** Wins out of wins and losses; a row with neither sorts below every rate. */
function rateColumn<T extends Record3>(label: string): StatsColumn<T> {
  return {
    label,
    sortValue: (row) => decidedRate(row.wins, row.losses) ?? -1,
    render: (row) => percent(decidedRate(row.wins, row.losses)),
  };
}

/** The tracker's teammate or opponent table: search, the first ten, more on request. */
function RelationTable({ title, column, rows }: { title: string; column: string; rows: PlayerRelation[] }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(10);
  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? rows.filter((row) => row.login.toLocaleLowerCase().includes(needle)) : rows;
  }, [query, rows]);
  return (
    <section className="player-stats-chart surface-panel">
      <div className="player-stats-head">
        <h3>{title}</h3>
        <input
          className="player-stats-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("playerCard.stats.search")}
          aria-label={t("playerCard.stats.searchAria", { table: title })}
        />
      </div>
      {matching.length === 0 ? (
        <p className="muted">{t("playerCard.stats.noRelations")}</p>
      ) : (
        <StatsTable
          rows={matching}
          limit={shown}
          columns={[
            {
              label: column,
              sortValue: (row) => row.login.toLocaleLowerCase(),
              render: (row) => (
                <button type="button" className="player-stats-name" onClick={() => void openPlayerCard(null, row.login)}>
                  {row.login}
                </button>
              ),
            },
            { label: t("playerCard.stats.games"), sortValue: (row) => row.games, render: (row) => formatNumber(row.games) },
            {
              label: t("playerCard.stats.winRate"),
              // The tracker's own rate here: wins out of games, draws included.
              sortValue: (row) => row.wins / Math.max(row.games, 1),
              render: (row) => percent((row.wins / Math.max(row.games, 1)) * 100),
            },
            { label: t("playerCard.stats.net"), sortValue: (row) => row.netHundredths, render: (row) => signedRating(row.netHundredths) },
            { label: t("playerCard.stats.gained"), sortValue: (row) => row.gainedHundredths, render: (row) => signedRating(row.gainedHundredths) },
            { label: t("playerCard.stats.lostRating"), sortValue: (row) => row.lostHundredths, render: (row) => signedRating(-row.lostHundredths) },
          ]}
        />
      )}
      {matching.length > shown && (
        <Button onClick={() => setShown((count) => count + 20)}>
          {t("playerCard.stats.showMore", { count: Math.min(20, matching.length - shown) })}
        </Button>
      )}
    </section>
  );
}

/** Best or worst months or days: three, the rest on request. */
function PeriodInsight({ title, rows, label, empty, firstNote }: {
  title: string;
  rows: PlayerPeriodStat[];
  label: (period: string) => string;
  empty: string;
  firstNote?: string;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  return (
    <article className="player-stats-insight">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul>
          {(all ? rows : rows.slice(0, 3)).map((row, index) => (
            <li key={row.period}>
              <strong>{label(row.period)}</strong>
              <span className="muted">
                {t("playerCard.stats.periodLine", {
                  rating: signedRating(row.ratingDeltaHundredths),
                  rate: percent(decidedRate(row.wins, row.losses)),
                  count: row.games,
                })}
                {index === 0 && firstNote ? `, ${firstNote}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 3 && (
        <Button onClick={() => setAll((open) => !open)}>
          {all ? t("playerCard.stats.showFewer") : t("playerCard.stats.showMore", { count: rows.length - 3 })}
        </Button>
      )}
    </article>
  );
}

/** Maps gaining or losing rating in the recent games. */
function MapInsight({ title, rows, from, to, empty }: {
  title: string;
  rows: Array<{ map: string; games: number; ratingDeltaHundredths: number }>;
  from: string;
  to: string;
  empty: string;
}) {
  const { t } = useTranslation();
  return (
    <article className="player-stats-insight">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <>
          {from !== "" && (
            <p className="muted player-stats-insight-note">
              {t("playerCard.stats.recentPeriod", { from: dayLabel(from), to: dayLabel(to) })}
            </p>
          )}
          <ul>
            {rows.map((row) => (
              <li key={row.map}>
                <strong>{row.map || t("playerCard.maps.generated")}</strong>
                <span className="muted">
                  {t("playerCard.stats.mapLine", { rating: signedRating(row.ratingDeltaHundredths), count: row.games })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}
