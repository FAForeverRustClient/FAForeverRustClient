// Play tab — the live game list. Auto-connects once on first view, then renders
// whatever the lobby slice holds; the list updates itself as the backend pushes
// GamesUpdated events. A Connect/Disconnect toggle drives the connection
// explicitly. Pure: select state + dispatch commands, no logic of its own.

import { useEffect } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import type { LobbyStatus } from "../../ipc/bindings";

const STATUS_LABEL: Record<LobbyStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Live",
};

const connect = () => ipc.dispatch({ kind: "Lobby", command: { type: "connect" } });
const disconnect = () => ipc.dispatch({ kind: "Lobby", command: { type: "disconnect" } });

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

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h2>Open games</h2>
        <span className="muted">{STATUS_LABEL[lobby.status]}</span>
        <span className="spacer" />
        <button className="btn-ghost" onClick={isLive ? disconnect : connect}>
          {isLive ? "Disconnect" : "Connect"}
        </button>
      </div>

      {lobby.games.length === 0 ? (
        <p className="muted">No open games.</p>
      ) : (
        <ul className="game-list">
          {lobby.games.map((g) => (
            <li key={g.id} className="game-row">
              <span className="game-title">{g.title}</span>
              <span className="game-map muted">{g.map}</span>
              <span className="game-host muted">host: {g.host}</span>
              <span className="game-players">
                {g.players}/{g.maxPlayers}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
