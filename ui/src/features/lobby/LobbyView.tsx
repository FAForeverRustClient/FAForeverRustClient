// Play tab — the live game list. Auto-connects once on first view, then renders
// whatever the lobby slice holds; the list updates itself as the backend pushes
// GamesUpdated events. A Connect/Disconnect toggle drives the connection
// explicitly. Each row has a Join button that dispatches Lobby.Join; the row
// reflects the join attempt's progress from the `join` slice (joining → launched
// → failed). Pure: select state + dispatch commands, no logic of its own.

import { useEffect } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import type { JoinState, LobbyStatus } from "../../ipc/bindings";

const STATUS_LABEL: Record<LobbyStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Live",
};

const connect = () => ipc.dispatch({ kind: "Lobby", command: { type: "connect" } });
const disconnect = () => ipc.dispatch({ kind: "Lobby", command: { type: "disconnect" } });
const join = (id: number) =>
  ipc.dispatch({ kind: "Lobby", command: { type: "join", payload: { id } } });

/** The join attempt's bearing on a specific game row. */
function rowJoin(joinState: JoinState, id: number): { label: string; busy: boolean; done: boolean } {
  const other = { label: "Join", busy: false, done: false };
  switch (joinState.type) {
    case "joining":
      return joinState.payload.id === id ? { label: "Joining…", busy: true, done: false } : other;
    case "launched":
      return joinState.payload.launch.uid === id
        ? { label: "Starting…", busy: true, done: false }
        : other;
    case "inGame":
      // We don't track which game id is in progress once launched; lock all rows.
      return { label: "In game", busy: true, done: true };
    case "failed":
      return joinState.payload.id === id ? { label: "Retry", busy: false, done: false } : other;
    case "launchFailed":
      return { label: "Join", busy: false, done: false };
    case "idle":
      return other;
  }
}

/** A human note about the current join attempt, shown in the header. */
function joinNote(joinState: JoinState): string | null {
  switch (joinState.type) {
    case "joining":
      return `Joining game ${joinState.payload.id}…`;
    case "launched":
      return `Launching “${joinState.payload.launch.name}” (${joinState.payload.launch.mapname})`;
    case "inGame":
      return "In game — adapter and game running";
    case "failed":
      return `Join failed: ${joinState.payload.reason}`;
    case "launchFailed":
      return `Launch failed: ${joinState.payload.reason}`;
    case "idle":
      return null;
  }
}

export function LobbyView() {
  const lobby = useAppStore((s) => s.state.lobby);

  // Connect once on first mount if idle. Deliberately not keyed on status, so a
  // user-initiated disconnect doesn't immediately reconnect.
  useEffect(() => {
    if (useAppStore.getState().state.lobby.status === "disconnected") {
      connect();
    }
  }, []);

  const isLive = lobby.status === "connected" || lobby.status === "connecting";
  const note = joinNote(lobby.join);

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h2>Open games</h2>
        <span className="muted">{STATUS_LABEL[lobby.status]}</span>
        {note && <span className="join-note muted">{note}</span>}
        <span className="spacer" />
        <Button onClick={isLive ? disconnect : connect}>
          {isLive ? "Disconnect" : "Connect"}
        </Button>
      </div>

      {lobby.games.length === 0 ? (
        <p className="muted">No open games.</p>
      ) : (
        <ul className="game-list">
          {lobby.games.map((g) => {
            const rj = rowJoin(lobby.join, g.id);
            return (
              <li key={g.id} className="game-row">
                <span className="game-title">{g.title}</span>
                <span className="game-map muted">{g.map}</span>
                <span className="game-host muted">host: {g.host}</span>
                <span className="game-players">
                  {g.players}/{g.maxPlayers}
                </span>
                <Button
                  variant="primary"
                  disabled={rj.busy || rj.done || !isLive}
                  onClick={() => join(g.id)}
                >
                  {rj.label}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
