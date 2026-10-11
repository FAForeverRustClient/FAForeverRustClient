import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import type { LeaderboardEntry } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { requestReplaySearch } from "../../shared/replaySearchIntent";
import { openPlayerCard } from "../../shared/playerCardActions";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName, includesName } from "../../shared/components/nameColors";
import { tierLabel } from "../../shared/leagueNames";
import { leaderboardLabel } from "../../shared/playerRatings";
import type { CrossRatings } from "./LeaderboardTable";

interface PlayerDetailsPanelProps {
  entry: LeaderboardEntry | null;
  heading?: string;
  /**
   * The rating boards, in the table's order, and the one the page is ranked
   * by. With them the panel lists the player on every board, which the table
   * already has in hand; a league table passes none and shows its own
   * numbers instead.
   */
  boards?: string[];
  rankedBoard?: string;
  crossRatings?: CrossRatings;
}

export function PlayerDetailsPanel({ entry, heading, boards, rankedBoard, crossRatings }: PlayerDetailsPanelProps) {
  const { t } = useTranslation();
  const title = heading ?? t("leaderboard.player.heading");
  const [copied, setCopied] = useState(false);
  const me = useAppStore((state) => state.state.auth.player);
  const friends = useAppStore((state) => state.state.social.friends);

  if (!entry) {
    return (
      <aside className="leaderboard-player-panel surface-panel is-empty">
        <h3>{title}</h3>
        <div className="leaderboard-player-empty">
          <Icon name="users" size={22} />
          <p className="muted">{t("leaderboard.player.selectRow")}</p>
        </div>
      </aside>
    );
  }

  const isMe = me?.id === entry.playerId;
  const isFriend = includesName(friends, entry.playerName);
  const setRelation = (relation: "friend", member: boolean) => ipc.send({
    kind: "Social",
    command: {
      type: "setRelation",
      payload: { playerId: entry.playerId, login: entry.playerName, relation, member },
    },
  });
  const message = () => {
    ipc.send({ kind: "Chat", command: { type: "joinChannel", payload: { channel: entry.playerName } } });
    ipc.send({ kind: "Chat", command: { type: "selectChannel", payload: { channel: entry.playerName } } });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "chat" } } });
  };
  // Handed to the Replays tab rather than sent from here. Sending the search
  // and the navigation as two messages raced: whichever landed first decided
  // whose replays you got, and when the navigation won, the tab found a vault
  // that had never been searched and ran its own default search over the top.
  const browseReplays = () => {
    requestReplaySearch({ ...EMPTY_REPLAY_QUERY, player: entry.playerName, exactPlayer: true });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
  };
  const copy = async () => {
    await navigator.clipboard.writeText(entry.playerName);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  // The ranked board's number is the row's own; every other board's comes
  // from the second request the table fills its columns from, and is a dash
  // until that has answered or when the player has never played there.
  const boardRating = (board: string) => board === rankedBoard
    ? entry.rating
    : crossRatings?.get(entry.playerId)?.get(board) ?? null;
  const divisionImage = entry.divisionMediumImageUrl || entry.divisionImageUrl;
  // Written as the table writes them, without a thousands separator, so the
  // same rating reads the same in both places.
  const numbers = (value: number | null) => value === null ? "-" : String(Math.round(value));

  return (
    <aside className="leaderboard-player-panel surface-panel">
      <h3>{title}</h3>
      <header className="leaderboard-player-head">
        <div className="leaderboard-player-name-row">
          {entry.avatarUrl && (
            <img
              className="leaderboard-avatar"
              src={entry.avatarUrl}
              alt=""
              title={entry.avatarTooltip || undefined}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          )}
          <span className="leaderboard-player-name"><PlayerName name={entry.playerName || t("common.unknown")} /></span>
          {/* Beside the name it copies, as the replay detail has it beside its
              id: a small thing done to the name, not an action of its own. */}
          <button
            type="button"
            className="leaderboard-copy-name"
            aria-label={t(copied ? "leaderboard.player.copied" : "leaderboard.player.copyName")}
            title={t(copied ? "leaderboard.player.copied" : "leaderboard.player.copyName")}
            onClick={() => void copy()}
          >
            <Icon name={copied ? "check" : "copy"} size={13} />
          </button>
        </div>
        <div className="leaderboard-player-standing">
          <span className="leaderboard-player-rank">#{entry.rank}</span>
          {rankedBoard && <span className="muted">{leaderboardLabel(rankedBoard)}</span>}
          {entry.division !== null && (
            <span className="leaderboard-player-division">
              {divisionImage && (
                <img
                  src={divisionImage}
                  alt=""
                  width={36}
                  height={18}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              )}
              {tierLabel(entry.division, entry.subdivision)}
            </span>
          )}
        </div>
      </header>

      {/* The training overview's facts strip: a label over each value and
          hairlines between them, on the same tinted ground. The boards
          first, the ranked one marked, then what the ranked number is made of. */}
      <section className="leaderboard-player-facts">
        {boards && boards.length > 0 ? (
          <>
            <dl className="leaderboard-facts" aria-label={t("leaderboard.view.ratings")}>
              {boards.map((board) => (
                <div key={board} className={board === rankedBoard ? "is-ranked" : undefined}>
                  <dt>{leaderboardLabel(board)}</dt>
                  <dd className={boardRating(board) === null ? "is-unknown" : undefined}>{numbers(boardRating(board))}</dd>
                </div>
              ))}
            </dl>
            <dl className="leaderboard-facts">
              <div><dt>{t("leaderboard.column.games")}</dt><dd>{entry.gamesPlayed}</dd></div>
              <div><dt>{t("leaderboard.column.mean")}</dt><dd>{numbers(entry.mean)}</dd></div>
              <div><dt>{t("leaderboard.column.deviation")}</dt><dd>{numbers(entry.deviation)}</dd></div>
            </dl>
          </>
        ) : (
          <dl className="leaderboard-facts">
            {entry.score !== null && <div><dt>{t("leaderboard.column.score")}</dt><dd>{entry.score}</dd></div>}
            {entry.rating !== null && <div><dt>{t("leaderboard.column.rating")}</dt><dd>{numbers(entry.rating)}</dd></div>}
            <div><dt>{t("leaderboard.column.games")}</dt><dd>{entry.gamesPlayed}</dd></div>
          </dl>
        )}
      </section>

      <div className="leaderboard-player-actions">
        <div className="leaderboard-player-action-list">
          {!isMe && (
            <Button variant="ghost" onClick={message}>
              <Icon name="chat" size={15} />
              {t("leaderboard.player.message")}
            </Button>
          )}
          <Button variant="ghost" onClick={browseReplays}>
            <Icon name="replays" size={15} />
            {t("leaderboard.player.browseReplays")}
          </Button>
          {!isMe && entry.playerId > 0 && (
            <Button variant="ghost" onClick={() => setRelation("friend", !isFriend)}>
              <Icon name={isFriend ? "close" : "plus"} size={15} />
              {t(isFriend ? "leaderboard.player.removeFriend" : "leaderboard.player.addFriend")}
            </Button>
          )}
        </div>
        <Button variant="primary" onClick={() => void openPlayerCard(entry.playerId, entry.playerName)}>
          <Icon name="users" size={15} />
          {t("leaderboard.player.fullProfile")}
        </Button>
      </div>
    </aside>
  );
}
