// Every leaderboard rating of one entrant, for the organiser (issue 158).
//
// Information and nothing more: only the event's own board decided the entry,
// the cap and the seed, and the dialog says so, so nobody mistakes a higher
// number on another board for a problem with the field.

import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { EntrantRatings, RatingKind, TourneyLoadStatus, TourneyPlayer } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { plainError } from "../../../shared/plainError";
import { formatDay, RATING_KIND_LABELS } from "../tourneyPresentation";

/** The boards as the website names them in this table. */
const BOARD_LABELS: Partial<Record<RatingKind, MessageKey>> = {
  global: "tournaments.ratings.boardGlobal",
  ladder1v1: "tournaments.ratings.boardLadder",
  team2v2: "tournaments.ratings.board2v2",
  team3v3: "tournaments.ratings.board3v3",
  team4v4: "tournaments.ratings.board4v4",
};

interface PlayerRatingsDialogProps {
  player: TourneyPlayer;
  ratings: EntrantRatings | null;
  status: TourneyLoadStatus;
  /** Ask the service again, from FAF this time. The first ask is the opener's. */
  onLoad: (refresh: boolean) => void;
  onClose: () => void;
}

export function PlayerRatingsDialog({ player, ratings, status, onLoad, onClose }: PlayerRatingsDialogProps) {
  const { t } = useTranslation();
  // An answer for somebody else, from a dialog closed a moment ago, is not
  // this player's.
  const mine = ratings !== null && ratings.playerId === player.id ? ratings : null;
  const loading = status.type === "loading";

  return (
    <Modal onClose={onClose} className="tournament-ratings-dialog" ariaLabel={player.name}>
      <h3>{t("tournaments.ratings.title", { name: player.name })}</h3>
      {loading && <p className="muted">{t("tournaments.ratings.asking")}</p>}
      {/* Plainly, with the service's own words on hover; Refresh, below, is
          the way to ask again. */}
      {status.type === "failed" && (
        <p className="tournament-form-hint" title={status.payload.reason}>
          {plainError(status.payload.reason)}
        </p>
      )}
      {!loading && mine !== null && mine.boards.length === 0 && (
        <p className="muted">{mine.reason || t("tournaments.ratings.none")}</p>
      )}
      {!loading && mine !== null && mine.boards.length > 0 && (
        <>
          <p className="muted">
            {t("tournaments.ratings.onlyCounts", {
              day: mine.ratingDate === null ? t("tournaments.ratings.atSignup") : formatDay(mine.ratingDate, ""),
              board: t(RATING_KIND_LABELS[mine.counts]),
            })}
          </p>
          <table className="tournament-ratings-table">
            <thead>
              <tr>
                <th scope="col">{t("tournaments.ratings.board")}</th>
                <th scope="col">{t("tournaments.ratings.rating")}</th>
                <th scope="col">{t("tournaments.ratings.games")}</th>
              </tr>
            </thead>
            <tbody>
              {mine.boards.map((row) => (
                <tr key={row.board} className={row.board === mine.counts ? "is-counted" : undefined}>
                  <td>
                    {t(BOARD_LABELS[row.board] ?? RATING_KIND_LABELS[row.board])}
                    {row.board === mine.counts && (
                      <span className="tournament-badge is-ok">{t("tournaments.ratings.counts")}</span>
                    )}
                  </td>
                  <td className="mono">{row.rating ?? "–"}</td>
                  <td className="mono muted">{row.games ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {mine.counts === "combined" && <p className="muted">{t("tournaments.ratings.combinedHint")}</p>}
          {mine.capped !== null && mine.countsRating !== null && (
            <p className="muted">
              {t("tournaments.ratings.cappedHint", { rating: mine.countsRating, capped: mine.capped })}
            </p>
          )}
        </>
      )}
      <div className="tournament-form-actions">
        <Button disabled={loading} onClick={() => onLoad(true)}>
          {t("tournaments.ratings.refresh")}
        </Button>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </div>
    </Modal>
  );
}
