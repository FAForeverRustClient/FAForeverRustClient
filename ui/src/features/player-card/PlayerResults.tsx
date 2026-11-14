// A player's games, one row each, newest first (#344).
//
// faftracker's "Game History": when, which queue, which map, how it ended and
// what it did to the rating, with the replay one click away. It reads the same
// history scan as the map record, so the outcome of a game is decided by the
// same rules in both places, and opening one tab after the other costs nothing.

import { useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { formatDecimal, formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { MapThumbnail } from "../../shared/components/MapThumbnail";
import { formatDateTime } from "../../shared/format/dates";
import { GENERATED_MAP_PLACEHOLDER_URL } from "../../shared/mapPresentation";
import { useAppStore } from "../../store/store";
import { closePlayerCard } from "../../shared/playerCardActions";
import { useRememberedFilters } from "../../shared/filterMemory";
import { leaderboardLabel } from "../../shared/playerRatings";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { requestReplaySearch } from "../../shared/replaySearchIntent";
import { usePlayerHistory } from "./usePlayerHistory";
import { HistoryFailure } from "./HistoryFailure";
import { HistoryBar } from "./HistoryBar";
import { ResultFiltersMenu } from "./ResultFiltersMenu";
import { Signed, StatTiles, TabCard } from "./StatParts";
import { filterResults, NO_RESULT_FILTERS, type ResultFilters } from "./resultFilters";

/** Rows added per press of "Show more". A long history is thousands. */
const PAGE = 50;

/** The roster's own words for an outcome, so a game reads the same here. */
const OUTCOME_KEYS = {
  win: "replays.roster.victory",
  loss: "replays.roster.defeat",
  draw: "replays.roster.draw",
} as const;

function openReplay(gameId: number) {
  requestReplaySearch({ ...EMPTY_REPLAY_QUERY, replayId: String(gameId) });
  ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
  closePlayerCard();
}

/** Hundredths of a point, signed the way a change reads: +12.5, -11.14. */
function ratingChange(hundredths: number): string {
  const value = formatNumber(Math.abs(hundredths) / 100);
  return hundredths > 0 ? `+${value}` : hundredths < 0 ? `-${value}` : value;
}

/** Wins, losses and draws among `games`. */
function tally(games: readonly { outcome: string }[]) {
  const record = { wins: 0, losses: 0, draws: 0 };
  for (const game of games) {
    if (game.outcome === "win") record.wins += 1;
    else if (game.outcome === "loss") record.losses += 1;
    else if (game.outcome === "draw") record.draws += 1;
  }
  return record;
}

/** One decimal place, signed the way a change reads: +12.5, -3.0. */
function signedDecimal(value: number): string {
  const text = formatDecimal(Math.abs(value));
  return value > 0 ? `+${text}` : value < 0 ? `-${text}` : text;
}

/**
 * What `games` did to the rating: the sum of every change, and that sum
 * spread over the games that changed it. A game with no rating data adds
 * nothing and is not counted, so an unrated game does not pull the average
 * towards zero. `null` when none of them has a change.
 */
function ratingSummary(games: readonly { ratingChangeHundredths: number | null }[]) {
  let total = 0;
  let rated = 0;
  for (const game of games) {
    if (game.ratingChangeHundredths === null) continue;
    total += game.ratingChangeHundredths;
    rated += 1;
  }
  return rated > 0 ? { total: total / 100, average: total / 100 / rated } : null;
}

/**
 * Percent of the decided games won, draws left out: the Maps tab's rule, so
 * the two tabs give the same figure for the same games. Unrounded for the
 * same reason as there.
 */
function winRate(wins: number, losses: number): number | null {
  const decided = wins + losses;
  return decided > 0 ? (wins / decided) * 100 : null;
}

export function PlayerResults({ playerId }: { playerId: number }) {
  const { t } = useTranslation();
  const { stats, status, error, full, loadFull, retry } = usePlayerHistory(playerId);
  const vault = useAppStore((state) => state.state.maps.vault);
  const [shown, setShown] = useState(PAGE);
  const { filters, setFilters } = useRememberedFilters<ResultFilters>("playerCard.results", NO_RESULT_FILTERS);
  const allGames = stats?.games;
  // The queues this player has games in, in the order they first appear.
  const queueOptions = useMemo(() => {
    const seen = new Map<string, number>();
    for (const game of allGames ?? []) seen.set(game.queue, (seen.get(game.queue) ?? 0) + 1);
    return [...seen].map(([queue, count]) => ({
      value: queue,
      label: leaderboardLabel(queue),
      detail: formatNumber(count),
    }));
  }, [allGames]);
  const games = useMemo(() => filterResults(allGames ?? [], filters), [allGames, filters]);

  if (status === "loading") {
    // `player-card-tab-loading`: the list is nearly always longer than the
    // card, so the card opens at its full height while the games are read,
    // not short first.
    return <div className="player-card-empty player-card-tab-loading muted" role="status">{t("playerCard.maps.loading")}</div>;
  }
  if (status === "failed") {
    // The way out beside the reason, as the card's own failed profile has it:
    // that reopening the tab also retries is not something to have to know.
    return <HistoryFailure error={error} onRetry={retry} />;
  }
  if (!stats || !allGames || allGames.length === 0) {
    return <div className="player-card-empty muted">{t("playerCard.results.empty")}</div>;
  }

  const hidden = stats.totalGames - allGames.length;
  const rows = games.slice(0, shown);
  // Over every game the filters keep, not only the rows "Show more" has
  // reached: the tiles answer "how did these games go", whatever is scrolled.
  const record = tally(games);
  const rate = winRate(record.wins, record.losses);
  const rating = ratingSummary(games);
  const ratedGames = games.filter((game) => game.ratingChangeHundredths !== null).length;

  return (
    <div className="player-results-view">
      <HistoryBar stats={stats} full={full} onLoadFull={loadFull} />

      {/* The Maps tab's three tiles, over the filtered games, so a filter
          change reads in them at once. */}
      <StatTiles
        columns={3}
        tiles={[
          {
            label: t("playerCard.maps.gamesTotal"),
            value: formatNumber(games.length),
            detail: t("playerCard.maps.gamesSplit", {
              ranked: formatNumber(ratedGames),
              unranked: formatNumber(games.length - ratedGames),
            }),
          },
          {
            label: t("playerCard.maps.winRate"),
            value: rate === null ? "–" : `${formatDecimal(rate)}%`,
            empty: rate === null,
            record,
            detail: t("playerCard.maps.recordSplit", {
              wins: formatNumber(record.wins),
              losses: formatNumber(record.losses),
              draws: formatNumber(record.draws),
            }),
          },
          {
            label: t("playerCard.results.ratingTotal"),
            value: rating ? <Signed value={rating.total}>{signedDecimal(rating.total)}</Signed> : "–",
            empty: rating === null,
            detail: rating ? (
              <>
                <Signed value={rating.average}>{signedDecimal(rating.average)}</Signed>{" "}
                {t("playerCard.results.ratingAverage")}
              </>
            ) : t("playerCard.results.noRating"),
          },
        ]}
      />

      {/* The games, under the Maps tab's card head: title and count at the
          start, the filters at the far end where the Maps tab has its search. */}
      <TabCard
        title={t("playerCard.tab.results")}
        count={formatNumber(games.length)}
        className="player-results-card"
        footnote={t("playerCard.results.note", { hidden: formatNumber(Math.max(0, hidden)) })}
        actions={
          <ResultFiltersMenu
            filters={filters}
            queues={queueOptions}
            onChange={(next) => {
              setFilters(next);
              setShown(PAGE);
            }}
          />
        }
      >
        {games.length === 0 && (
          <p className="player-tab-card-empty muted">{t("playerCard.results.filter.empty")}</p>
        )}

        {/* The map leads, picture first, as on the Maps tab: it is what tells
            one game from another, and the table gives its first column the
            room the others leave. With the date first, the date was the column
            that took it, and stood a long way from the rest of its row. */}
        {games.length > 0 && (
        <div className="player-tab-table">
        <table className="player-maps-table player-results-table">
          <thead>
            <tr className="list-head">
              <th>{t("playerCard.maps.map")}</th>
              <th>{t("playerCard.results.date")}</th>
              <th>{t("playerCard.results.queue")}</th>
              <th>{t("playerCard.results.result")}</th>
              <th>{t("playerCard.results.rating")}</th>
              <th>{t("playerCard.results.replay")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((game) => {
              const map = game.generated ? t("playerCard.maps.generated") : game.map;
              const outcomeKey = OUTCOME_KEYS[game.outcome as keyof typeof OUTCOME_KEYS];
              return (
                <tr key={game.gameId}>
                  <td className="player-results-map" title={map}>
                    {/* The small map picture chat shows beside a game, from the
                        map version's folder. A generated map has no folder (the
                        API names no version for one), so it gets the picture
                        every generated map shows before it is rendered. */}
                    <span className="player-results-map-cell">
                      {game.generated ? (
                        <img
                          className="player-results-map-thumb"
                          src={GENERATED_MAP_PLACEHOLDER_URL}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <MapThumbnail
                          mapName={game.mapFolder}
                          vault={vault}
                          className="player-results-map-thumb"
                          placeholderClassName="player-results-map-thumb player-results-map-thumb-empty"
                          iconSize={14}
                          preferCanonicalPreview
                        />
                      )}
                      <span className="player-results-map-name">{map}</span>
                    </span>
                  </td>
                  <td className="player-results-date">{game.playedAt ? formatDateTime(game.playedAt) : "–"}</td>
                  <td><span className="player-results-queue">{leaderboardLabel(game.queue)}</span></td>
                  <td>
                    {/* The Replays tab's result badge, the roster's word in it. */}
                    <span className={`player-results-outcome is-${game.outcome}`}>
                      {outcomeKey ? t(outcomeKey) : game.outcome}
                    </span>
                  </td>
                  <td className={game.ratingChangeHundredths === null ? "muted" : "player-results-rating"}>
                    {game.ratingChangeHundredths === null
                      ? t("playerCard.results.noRating")
                      : (
                        <Signed value={game.ratingChangeHundredths}>{ratingChange(game.ratingChangeHundredths)}</Signed>
                      )}
                  </td>
                  <td>
                    <button type="button" className="player-results-replay" onClick={() => openReplay(game.gameId)}>
                      <Icon name="play" size={11} />
                      #{game.gameId}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        )}

        {/* Below the table, not above it (issue 362): the reader reaches the
            end of the rows and the next page is where they already are,
            instead of having scrolled the button off the top of the tab. */}
        {shown < games.length && (
          <div className="player-tab-card-foot">
            <Button onClick={() => setShown((count) => count + PAGE)}>
              {t("playerCard.results.showMore", {
                shown: formatNumber(Math.min(shown, games.length)),
                total: formatNumber(games.length),
              })}
            </Button>
          </div>
        )}
      </TabCard>
    </div>
  );
}
