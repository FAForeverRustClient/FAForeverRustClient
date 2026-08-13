import { useState } from "react";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import type { LeaderboardEntry } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { openPlayerCard } from "../player-card/playerCardActions";

interface PlayerDetailsPanelProps {
  entry: LeaderboardEntry | null;
  heading?: string;
}

export function PlayerDetailsPanel({ entry, heading = "Player details" }: PlayerDetailsPanelProps) {
  const [copied, setCopied] = useState(false);
  const me = useAppStore((state) => state.state.auth.player);
  const friends = useAppStore((state) => state.state.social.friends);
  const foes = useAppStore((state) => state.state.social.foes);

  if (!entry) {
    return (
      <aside className="leaderboard-player-panel surface-panel">
        <h3>{heading}</h3>
        <p className="muted">Select a row to inspect the player and open related actions.</p>
      </aside>
    );
  }

  const isMe = me?.id === entry.playerId;
  const isFriend = friends.includes(entry.playerName);
  const isFoe = foes.includes(entry.playerName);
  const setRelation = (relation: "friend" | "foe", member: boolean) => ipc.send({
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
  const browseReplays = () => {
    ipc.send({
      kind: "Replays",
      command: {
        type: "searchVault",
        payload: { query: { ...EMPTY_REPLAY_QUERY, player: entry.playerName, exactPlayer: true } },
      },
    });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
  };
  const copy = async () => {
    await navigator.clipboard.writeText(entry.playerName);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <aside className="leaderboard-player-panel surface-panel">
      <h3>{heading}</h3>
      <div className="leaderboard-player-identity">
        {entry.avatarUrl ? (
          <img
            className="leaderboard-player-avatar"
            src={entry.avatarUrl}
            alt=""
            title={`${entry.playerName} avatar`}
            width={56}
            height={28}
            decoding="async"
            draggable={false}
          />
        ) : (
          <span className="leaderboard-player-avatar leaderboard-avatar-slot" aria-hidden="true" />
        )}
        <div className="leaderboard-player-name">{entry.playerName}</div>
      </div>
      {entry.division && <div className="leaderboard-player-division muted">{entry.division}</div>}
      <dl className="leaderboard-player-stats">
        <div><dt>Rank</dt><dd>#{entry.rank}</dd></div>
        {entry.score !== null && <div><dt>Score</dt><dd>{entry.score}</dd></div>}
        {entry.rating !== null && <div><dt>Rating</dt><dd>{entry.rating}</dd></div>}
        <div><dt>Games</dt><dd>{entry.gamesPlayed}</dd></div>
      </dl>
      <div className="leaderboard-player-actions">
        <Button variant="primary" onClick={() => void openPlayerCard(entry.playerId, entry.playerName)}>Full profile</Button>
        <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy name"}</Button>
        {!isMe && <Button onClick={message}>Message</Button>}
        <Button onClick={browseReplays}>Browse replays</Button>
        {!isMe && entry.playerId > 0 && (
          <>
            <Button onClick={() => setRelation("friend", !isFriend)}>{isFriend ? "Remove friend" : "Add friend"}</Button>
            <Button onClick={() => setRelation("foe", !isFoe)}>{isFoe ? "Remove foe" : "Mark as foe"}</Button>
          </>
        )}
      </div>
    </aside>
  );
}
