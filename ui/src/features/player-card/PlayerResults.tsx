// A player's games, one row each, newest first (#344).
//
// faftracker's "Game History": when, which queue, which map, how it ended and
// what it did to the rating, with the replay one click away. It reads the same
// history scan as the map record, so the outcome of a game is decided by the
// same rules in both places, and opening one tab after the other costs nothing.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { formatDecimal, formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { formatDateTime } from "../../shared/format/dates";
import { closePlayerCard } from "../../shared/playerCardActions";
import { leaderboardLabel } from "../../shared/playerRatings";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { requestReplaySearch } from "../../shared/replaySearchIntent";
import { usePlayerHistory } from "./usePlayerHistory";

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
  const { stats, status, error } = usePlayerHistory(playerId);
  const [shown, setShown] = useState(PAGE);

  if (status === "loading") {
    return <div className="player-card-empty muted">{t("playerCard.maps.loading")}</div>;
  }
  if (status === "failed") {
    return <div className="player-card-empty muted">{error || t("playerCard.maps.failed")}</div>;
  }
  const games = stats?.games ?? [];
  if (!stats || games.length === 0) {
    return <div className="player-card-empty muted">{t("playerCard.results.empty")}</div>;
  }

  const hidden = stats.totalGames - games.length;
  const rows = games.slice(0, shown);
  const record = tally(rows);
  const rate = winRate(record.wins, record.losses);

  return (
    <div className="player-results-view">
      <div className="player-results-head">
        {/* Said, the way the tracker says it: the list is the games whose
            outcome is known, and the rest of the history is not missing by
            accident. */}
        <p className="player-maps-note muted">
          {t("playerCard.results.note", { hidden: formatNumber(Math.max(0, hidden)) })}
        </p>
        {/* The rows on screen, not the whole history: the Maps tab already
            gives the record over everything, and this follows "Show more". */}
        <p className="player-results-summary" aria-live="polite">
          <span className="muted">{t("playerCard.results.shownSummary", { count: rows.length })}</span>{" "}
          {t("playerCard.maps.recordSplit", {
            wins: formatNumber(record.wins),
            losses: formatNumber(record.losses),
            draws: formatNumber(record.draws),
          })}
          {rate !== null && (
            <>
              <span className="muted"> · {t("playerCard.maps.winRate")}</span> <strong>{formatDecimal(rate)}%</strong>
            </>
          )}
        </p>
      </div>

      <table className="surface-panel player-maps-table player-results-table">
        <thead>
          <tr>
            <th>{t("playerCard.results.date")}</th>
            <th>{t("playerCard.results.queue")}</th>
            <th>{t("playerCard.maps.map")}</th>
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
                <td>{game.playedAt ? formatDateTime(game.playedAt) : "–"}</td>
                <td>{leaderboardLabel(game.queue)}</td>
                <td className="player-results-map" title={map}>{map}</td>
                <td className={`player-results-outcome is-${game.outcome}`}>
                  {outcomeKey ? t(outcomeKey) : game.outcome}
                </td>
                <td className={game.ratingChangeHundredths === null ? "muted" : undefined}>
                  {game.ratingChangeHundredths === null
                    ? t("playerCard.results.noRating")
                    : ratingChange(game.ratingChangeHundredths)}
                </td>
                <td>
                  <button type="button" className="player-results-replay" onClick={() => openReplay(game.gameId)}>
                    #{game.gameId}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Below the table, not above it (issue 362): the reader reaches the end
          of the rows and the next page is where they already are, instead of
          having scrolled the button off the top of the tab. */}
      {shown < games.length && (
        <div className="player-results-more">
          <Button onClick={() => setShown((count) => count + PAGE)}>
            {t("playerCard.results.showMore", {
              shown: formatNumber(Math.min(shown, games.length)),
              total: formatNumber(games.length),
            })}
          </Button>
        </div>
      )}
    </div>
  );
}
