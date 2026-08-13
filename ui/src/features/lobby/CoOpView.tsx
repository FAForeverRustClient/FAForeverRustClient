// Co-Op subtab — browses currently open co-op lobbies (filtered from the same
// open-games stream Custom Games uses, by `gameType === "coop""). Confirmed
// against `D:\py-client\src\coop\_coopwidget.py`: hosting a co-op game means
// sending `game_host` with `mod: "coop"`, but that requires picking a
// scenario from the server's `coop_info` message — a separate protocol
// surface this client doesn't parse yet. So for now this tab is read-only
// (browse + join existing lobbies); hosting is a follow-up once `coop_info`
// is researched the same way `game_host` was for Custom Games.

import { useEffect, useMemo } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import { GameCard } from "../../design-system/Card";
import { mapLabel, useMapInfo } from "./mapInfo";
import type { JoinState } from "../../ipc/bindings";

const connect = () => ipc.dispatch({ kind: "Lobby", command: { type: "connect" } });
const join = (id: number) =>
  ipc.dispatch({ kind: "Lobby", command: { type: "join", payload: { id } } });

function rowJoin(joinState: JoinState, id: number): { busy: boolean; done: boolean } {
  switch (joinState.type) {
    case "joining":
      return { busy: joinState.payload.id === id, done: false };
    case "launched":
      return { busy: joinState.payload.launch.uid === id, done: false };
    case "inGame":
      return { busy: true, done: true };
    default:
      return { busy: false, done: false };
  }
}

function joinNote(joinState: JoinState): string | null {
  switch (joinState.type) {
    case "joining":
      return `Joining game ${joinState.payload.id}…`;
    case "launched":
      return `Launching “${joinState.payload.launch.name}”…`;
    case "inGame":
      return "In game — adapter and game running";
    case "failed":
      return `Join failed: ${joinState.payload.reason}`;
    default:
      return null;
  }
}

export function CoOpView() {
  const lobby = useAppStore((s) => s.state.lobby);
  const mapInfo = useMapInfo();

  // Same auto-connect posture as CustomGamesView.tsx's own useEffect — don't
  // rely on Custom Games having been opened first.
  useEffect(() => {
    if (useAppStore.getState().state.lobby.status === "disconnected") {
      connect();
    }
  }, []);

  const coopGames = useMemo(
    () => lobby.games.filter((g) => g.gameType === "coop"),
    [lobby.games],
  );

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h2>Co-Op</h2>
        <span className="muted">
          {lobby.status === "connected" ? "Live" : lobby.status === "connecting" ? "Connecting…" : "Disconnected"}
        </span>
        {joinNote(lobby.join) && <span className="join-note muted">{joinNote(lobby.join)}</span>}
        <span className="spacer" />
        {lobby.status === "disconnected" && <Button onClick={connect}>Connect</Button>}
      </div>

      <p className="muted">
        Hosting a co-op game isn't wired up yet — it needs its own scenario picker. Browse and join open co-op lobbies below.
      </p>

      {coopGames.length === 0 ? (
        <p className="muted">No open co-op games.</p>
      ) : (
        <div className="game-tile-grid">
          {coopGames.map((g) => {
            const rj = rowJoin(lobby.join, g.id);
            return (
              <GameCard
                key={g.id}
                title={g.title}
                map={mapLabel(g.map, mapInfo)}
                host={g.host}
                players={g.players}
                maxPlayers={g.maxPlayers}
                gamemode="Co-Op"
                locked={g.passwordProtected}
                friendsOnly={g.visibility === "friends"}
                thumbnailUrl={mapInfo.get(g.map.toLowerCase())?.thumbnailUrl}
                onClick={() => !rj.busy && !rj.done && join(g.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
