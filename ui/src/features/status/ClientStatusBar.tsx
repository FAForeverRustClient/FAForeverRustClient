import { useEffect, useRef, useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import type {
  ChatStatus,
  JoinState,
  LobbyStatus,
  ReplayDownloadStatus,
} from "../../ipc/bindings";
import "./status.css";

type ConnectionKind = "faf" | "chat";
type ConnectionStatus = ChatStatus | LobbyStatus;

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: "offline",
  connecting: "connecting",
  connected: "connected",
};

function connectionLabel(status: ConnectionStatus): string {
  return STATUS_LABEL[status];
}

export function GamePreparationStatus({
  state,
}: {
  state: Extract<JoinState, { type: "preparing" }>;
}) {
  const progress = state.payload.progress === null
    ? null
    : Math.min(100, Math.max(0, state.payload.progress));

  return (
    <div className="client-status-task" aria-live="polite">
      <span className="client-status-task-label" title={`Match setup: ${state.payload.detail}`}>
        <strong>Match setup:</strong> {state.payload.detail}
      </span>
      <span
        className="client-status-progress"
        data-indeterminate={progress === null ? "true" : undefined}
        role="progressbar"
        aria-label="Match setup"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress ?? undefined}
        aria-valuetext={progress === null ? state.payload.detail : `${state.payload.detail}, ${progress}%`}
      >
        <span style={progress === null ? undefined : { width: `${progress}%` }} />
      </span>
      <span className="client-status-task-percent">
        {progress === null ? "Active" : `${progress}%`}
      </span>
    </div>
  );
}

/**
 * The non-progress join phases, in the same slot as the preparation bar.
 *
 * These used to be an inline banner above the game list, which pushed the
 * workspace down for one line of text and put "Launching …" somewhere the eye
 * is not looking once the game is starting. The status bar already owns
 * long-running client state, so they belong beside it.
 */
export function GameJoinStatus({ state }: { state: JoinState }) {
  const note = joinStatusNote(state);
  if (note === null) return null;
  return (
    <div className="client-status-task" aria-live="polite">
      <span className="client-status-task-label" title={note}>{note}</span>
    </div>
  );
}

function joinStatusNote(state: JoinState): string | null {
  switch (state.type) {
    case "joining": return `Connecting to match ${state.payload.id}…`;
    case "launched": return `Initiating “${state.payload.launch.name}”`;
    case "failed": return `Join failed: ${state.payload.reason.replace(/_/g, " ")}`;
    // In-game needs no narration, and a launch failure is retained by the
    // notification centre where it can be dismissed.
    case "inGame":
    case "launchFailed":
    case "preparing":
    case "idle":
      return null;
  }
}

/**
 * Replay downloads use the same bottom task slot as match preparation. The
 * replay service cannot know a reliable total size through every CDN path, so
 * this deliberately stays indeterminate instead of showing a misleading
 * percentage.
 */
export function ReplayDownloadTask({
  status,
}: {
  status: Extract<ReplayDownloadStatus, { type: "downloading" }>;
}) {
  const uid = status.payload.uid;
  return (
    <div className="client-status-task" aria-live="polite">
      <span className="client-status-task-label" title={`Downloading replay ${uid}`}>
        <strong>Replay:</strong> Downloading {uid}
      </span>
      <span
        className="client-status-progress"
        data-indeterminate="true"
        role="progressbar"
        aria-label="Downloading replay"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext="Active"
      >
        <span />
      </span>
      <span className="client-status-task-percent">Active</span>
    </div>
  );
}

export function ClientStatusBar() {
  const session = useAppStore((state) => state.state.session);
  const player = useAppStore((state) => state.state.auth.player);
  const lobbyStatus = useAppStore((state) => state.state.lobby.status);
  const joinState = useAppStore((state) => state.state.lobby.join);
  const replayDownloadStatus = useAppStore((state) => state.state.replays.downloadStatus);
  const chatStatus = useAppStore((state) => state.state.chat.status);
  const [openMenu, setOpenMenu] = useState<ConnectionKind | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const joinTaskVisible = joinState.type === "joining"
    || joinState.type === "launched"
    || joinState.type === "failed";

  useEffect(() => {
    if (!openMenu) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpenMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  const reconnect = async (kind: ConnectionKind) => {
    setOpenMenu(null);
    if (kind === "faf") {
      if (lobbyStatus === "disconnected") {
        await ipc.dispatch({ kind: "Lobby", command: { type: "connect" } });
      } else {
        await ipc.dispatch({ kind: "Lobby", command: { type: "disconnect" } });
      }
      return;
    }

    if (chatStatus === "disconnected") {
      if (player?.name) {
        await ipc.dispatch({ kind: "Chat", command: { type: "connect", payload: { username: player.name } } });
      }
    } else {
      await ipc.dispatch({ kind: "Chat", command: { type: "disconnect" } });
    }
  };

  const renderConnectionMenu = (kind: ConnectionKind, status: ConnectionStatus, label: string) => {
    const isOpen = openMenu === kind;
    const canConnect = kind !== "chat" || Boolean(player?.name);
    const actionLabel = status === "disconnected" ? "Reconnect" : "Disconnect";

    return (
      <div className="client-status-menu" key={kind}>
        <button
          type="button"
          className="client-status-connection"
          data-status={status}
          aria-expanded={isOpen}
          aria-haspopup="menu"
          aria-controls={`client-status-menu-${kind}`}
          onClick={() => setOpenMenu(isOpen ? null : kind)}
        >
          <i aria-hidden="true" />
          <span>{label} {connectionLabel(status)}</span>
          <span className="client-status-chevron" aria-hidden="true" />
        </button>
        {isOpen && (
          <div className="client-status-popover" id={`client-status-menu-${kind}`} role="menu">
            <div className="client-status-popover-heading">
              <span className="client-status-popover-dot" data-status={status} aria-hidden="true" />
              <span>{label} connection</span>
              <strong>{connectionLabel(status)}</strong>
            </div>
            <button
              type="button"
              className="client-status-action"
              role="menuitem"
              disabled={!canConnect}
              onClick={() => void reconnect(kind)}
            >
              {actionLabel}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <footer ref={rootRef} className="client-status-bar" aria-label="Client status">
      <span className="client-status-version">v{session.backendVersion || "0.3.0"}</span>
      {joinState.type === "preparing"
        ? <GamePreparationStatus state={joinState} />
        : joinTaskVisible
          ? <GameJoinStatus state={joinState} />
          : replayDownloadStatus.type === "downloading"
            ? <ReplayDownloadTask status={replayDownloadStatus} />
            : null}
      <div className="client-status-connections">
        {renderConnectionMenu("faf", lobbyStatus, "FAF")}
        {renderConnectionMenu("chat", chatStatus, "Chat")}
      </div>
    </footer>
  );
}
