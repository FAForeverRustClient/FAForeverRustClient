import { useEffect, useRef, useState } from "react";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import type {
  AppCommand,
  AppState,
  ChatStatus,
  JoinState,
  LobbyStatus,
  UploadsState,
} from "../../ipc/bindings";
import { isUploadBusy, isUploadCancellable } from "../../store/reducers/uploads";
import { plainError } from "../../shared/plainError";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import "./status.css";

type ConnectionKind = "faf" | "chat";
type ConnectionStatus = ChatStatus | LobbyStatus;

const STATUS_LABEL = {
  disconnected: "status.connection.disconnected",
  connecting: "status.connection.connecting",
  connected: "status.connection.connected",
} as const satisfies Record<ConnectionStatus, MessageKey>;

/** A percentage held to 0..100, or `null` for work nobody can measure. */
function boundedPercent(progress: number | null): number | null {
  return progress === null ? null : Math.min(100, Math.max(0, Math.round(progress)));
}

/**
 * The bar and its number, shared by every task in the slot: a bar that fills
 * when the backend measures the work, a sweep that says "running" without
 * claiming a position when it cannot.
 */
function TaskProgress({ label, progress }: { label: string; progress: number | null }) {
  const { t } = useTranslation();
  const percent = boundedPercent(progress);
  return (
    <>
      <span
        className="client-status-progress"
        data-indeterminate={percent === null ? "true" : undefined}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? t("status.active") : `${percent}%`}
      >
        <span style={percent === null ? undefined : { width: `${percent}%` }} />
      </span>
      <span className="client-status-task-percent">
        {percent === null ? t("status.active") : `${percent}%`}
      </span>
    </>
  );
}

/** The one control a task offers in the bar: stop it, named for what it stops. */
function TaskCancel({ label, onCancel }: { label: string; onCancel: () => void }) {
  return (
    <button
      type="button"
      className="client-status-task-action"
      onClick={onCancel}
      aria-label={label}
      title={label}
    >
      <Icon name="close" size={12} />
    </button>
  );
}

const cancelJoin = () => ipc.send({ kind: "Lobby", command: { type: "cancelJoin" } });

export function GamePreparationStatus({
  state,
}: {
  state: Extract<JoinState, { type: "preparing" }>;
}) {
  const { t } = useTranslation();
  const progress = boundedPercent(state.payload.progress);

  return (
    <div className="client-status-task" aria-live="polite">
      <span
        className="client-status-task-label"
        title={t("status.matchSetup.title", { detail: state.payload.detail })}
      >
        <strong>{t("status.matchSetup.label")}</strong> {state.payload.detail}
      </span>
      <span
        className="client-status-progress"
        data-indeterminate={progress === null ? "true" : undefined}
        role="progressbar"
        aria-label={t("status.matchSetup.aria")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress ?? undefined}
        aria-valuetext={progress === null ? state.payload.detail : `${state.payload.detail}, ${progress}%`}
      >
        <span style={progress === null ? undefined : { width: `${progress}%` }} />
      </span>
      <span className="client-status-task-percent">
        {progress === null ? t("status.active") : `${progress}%`}
      </span>
      {/* The join dialog can be hidden for a long patch, and this line is
          what stays: so it carries the dialog's Cancel too. */}
      <TaskCancel label={t("lobby.joinProgress.cancel")} onCancel={cancelJoin} />
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
  const { t } = useTranslation();
  const note = joinStatusNote(state, t);
  if (note === null) return null;
  return (
    <div className="client-status-task" aria-live="polite">
      <span className="client-status-task-label" title={state.type === "failed" ? state.payload.reason : note}>{note}</span>
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function joinStatusNote(state: JoinState, t: Translate): string | null {
  switch (state.type) {
    case "joining": return t("status.join.connecting", { id: state.payload.id });
    case "launched": return t("status.join.launched", { name: state.payload.launch.name });
    case "failed": return t("status.join.failed", { reason: plainError(state.payload.reason) });
    // In-game needs no narration, a launch failure is retained by the
    // notification centre where it can be dismissed, and a pending mod
    // replacement is already a modal the user is looking at.
    case "inGame":
    case "launchFailed":
    case "preparing":
    case "needsModReplacement":
    case "idle":
      return null;
  }
}

/**
 * One thing the client is busy with in the background, as the task slot
 * shows it.
 */
export interface BackgroundActivity {
  /** Which operation this is: stable across redraws, and what tests find. */
  id: string;
  label: string;
  /** Percent when the backend measures the work, `null` for a sweep. */
  progress: number | null;
  /** Stops it in the backend, where it can be stopped. */
  cancel?: () => void;
}

/** A transfer's share in whole percent, or `null` while its size is unknown. */
function shareOf(done: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : null;
}

function uploadPercent(status: UploadsState["status"]): number | null {
  switch (status.type) {
    case "compressing":
      return shareOf(status.payload.doneBytes, status.payload.totalBytes);
    case "uploading":
      return shareOf(status.payload.sentBytes, status.payload.totalBytes);
    default:
      return null;
  }
}

/** A cancel that sends `command`. */
const send = (command: AppCommand) => () => ipc.send(command);

/**
 * Everything the client is busy with in the background, in the order it
 * matters: work the player started and is waiting for first (a replay
 * starting, downloads, installs, publishing, updates), then searches, then
 * catalogues being read.
 *
 * One fixed place for "something is on its way", which is what this bar
 * already was for match preparation. The views used to say it themselves, each
 * in its own words and position, or not at all. Failures stay in the views,
 * beside the thing that failed and its Retry.
 *
 * Each value is read on its own, as a string, a number or a boolean: a
 * selector that built the list would hand the store a new array every time and
 * redraw the bar on every state change. The list is built here instead, from
 * values that only change when what the bar says does.
 */
export function useBackgroundActivities(): BackgroundActivity[] {
  const { t } = useTranslation();

  // A replay being started, from any of the four ways to start one. Its
  // starting dialog can be hidden, and a hidden one said nothing anywhere.
  const replayStarting = useAppStore((s) => s.state.replays.status.type === "connecting");
  const replayStep = useAppStore((s) => s.state.replays.preparing?.detail ?? null);
  const replayStepProgress = useAppStore((s) => s.state.replays.preparing?.progress ?? null);
  const replayDownload = useAppStore((s) =>
    s.state.replays.downloadStatus.type === "downloading" ? s.state.replays.downloadStatus.payload.uid : null);
  const replayDownloadProgress = useAppStore((s) =>
    s.state.replays.downloadStatus.type === "downloading" ? s.state.replays.downloadStatus.payload.progress : null);

  // A publish whose dialog was hidden. Hiding does not stop it, so this is
  // where it stays visible until the notification with the result.
  const publishing = useAppStore((s) => s.state.uploads.request === null && isUploadBusy(s.state.uploads.status));
  const publishPercent = useAppStore((s) => uploadPercent(s.state.uploads.status));
  const publishCancellable = useAppStore((s) => isUploadCancellable(s.state.uploads.status));

  // An install and an uninstall share one status. A folder that is already
  // installed is being removed: an install of one is skipped by the service.
  const mapFolder = useAppStore((s) =>
    s.state.maps.installStatus.type === "installing" ? s.state.maps.installStatus.payload.folderName : null);
  const mapInstallProgress = useAppStore((s) =>
    s.state.maps.installStatus.type === "installing" ? s.state.maps.installStatus.payload.progress : null);
  const mapName = useAppStore((s) => {
    if (mapFolder === null) return null;
    const folder = mapFolder.toLowerCase();
    return s.state.maps.vault.find((map) => map.folderName.toLowerCase() === folder)?.displayName ?? mapFolder;
  });
  const mapRemoving = useAppStore((s) => {
    if (mapFolder === null) return false;
    const folder = mapFolder.toLowerCase();
    return s.state.maps.installed.some((map) => map.folderName.toLowerCase() === folder);
  });
  const modName = (mods: AppState["mods"], uid: string) =>
    mods.vault.find((mod) => mod.uid === uid)?.displayName
    ?? mods.installed.find((mod) => mod.uid === uid)?.displayName
    ?? uid;
  const modUid = useAppStore((s) =>
    s.state.mods.installStatus.type === "installing" ? s.state.mods.installStatus.payload.uid : null);
  const modInstallProgress = useAppStore((s) =>
    s.state.mods.installStatus.type === "installing" ? s.state.mods.installStatus.payload.progress : null);
  const modInstallName = useAppStore((s) => (modUid === null ? null : modName(s.state.mods, modUid)));
  const modRemoving = useAppStore((s) =>
    modUid !== null && s.state.mods.installed.some((mod) => mod.uid === modUid));
  const modToggle = useAppStore((s) =>
    s.state.mods.toggleStatus.type === "toggling"
      ? modName(s.state.mods, s.state.mods.toggleStatus.payload.uid)
      : null);

  // The client's own installer, and the separate Galactic War client.
  const updateVersion = useAppStore((s) =>
    s.state.clientUpdate.status.type === "downloading" ? (s.state.clientUpdate.release?.version ?? "") : null);
  const updatePercent = useAppStore((s) =>
    s.state.clientUpdate.status.type === "downloading"
      ? shareOf(s.state.clientUpdate.status.payload.receivedBytes, s.state.clientUpdate.status.payload.totalBytes)
      : null);
  const galacticWar = useAppStore((s) => {
    const status = s.state.galacticWar.status;
    return status.type === "downloading" || status.type === "installing" ? status.payload.version : null;
  });
  const galacticWarPercent = useAppStore((s) => {
    const status = s.state.galacticWar.status;
    return status.type === "downloading" ? shareOf(status.payload.downloadedBytes, status.payload.totalBytes) : null;
  });
  // A tutorial's game is brought up to date before it starts, which on a
  // stale install is the same long patch a lobby join is.
  const tutorialStep = useAppStore((s) =>
    s.state.tutorials.launch.type === "preparing" ? s.state.tutorials.launch.payload.detail : null);

  // A map being generated, from wherever it was asked for: a replay card's
  // "+", the replay or game details, the Maps tab. Only the Maps tab showed
  // its progress, so generating from anywhere else ran for a minute with
  // nothing on screen saying so, and only the Maps tab could stop it.
  const mapGeneration = useAppStore((s) => {
    const status = s.state.mapGenerator.status;
    switch (status.type) {
      case "preparing":
      case "resolvingVersion":
        return t("replays.detail.preparingGenerator");
      case "downloading":
        return t("maps.generate.downloading", { version: status.payload.version });
      case "generating":
        return t("lobby.details.generatingMap");
      default:
        return null;
    }
  });
  const mapGenerationPercent = useAppStore((s) => {
    const status = s.state.mapGenerator.status;
    return status.type === "downloading" && status.payload.totalBytes
      ? shareOf(status.payload.downloadedBytes, status.payload.totalBytes)
      : null;
  });

  const mapSearch = useAppStore((s) => s.state.maps.browseStatus.type === "loading");
  const modSearch = useAppStore((s) => s.state.mods.browseStatus.type === "loading");
  const replaySearch = useAppStore((s) => s.state.replays.vaultStatus.type === "loading");
  const mapScan = useAppStore((s) => s.state.maps.installedStatus.type === "loading");
  const modScan = useAppStore((s) => s.state.mods.installedStatus.type === "loading");
  const mapVault = useAppStore((s) => s.state.maps.vaultStatus.type === "loading");
  const modVault = useAppStore((s) => s.state.mods.vaultStatus.type === "loading");
  const leaderboards = useAppStore((s) =>
    s.state.leaderboard.catalogStatus.type === "loading"
    || s.state.leaderboard.ratingsStatus.type === "loading"
    || s.state.leaderboard.seasonStatus.type === "loading");
  const events = useAppStore((s) => s.state.events.status.type === "loading");
  const tournaments = useAppStore((s) => s.state.tourney.status.type === "loading");
  const changelog = useAppStore((s) => s.state.changelog.status.type === "loading");

  const activities: (BackgroundActivity | false)[] = [
    replayStarting && {
      id: "replay-start",
      label: replayStep
        ? t("status.activity.startingReplayStep", { detail: replayStep })
        : t("status.activity.startingReplay"),
      progress: replayStepProgress,
      cancel: send({ kind: "Replays", command: { type: "cancelWatch" } }),
    },
    replayDownload !== null && {
      id: "replay-download",
      label: t("status.activity.downloadingReplay", { uid: replayDownload }),
      progress: replayDownloadProgress,
      cancel: send({ kind: "Replays", command: { type: "cancelDownload", payload: { uid: replayDownload } } }),
    },
    publishing && {
      id: "upload",
      label: t("status.upload.label"),
      progress: publishPercent,
      // Gone once every byte is out: the vault decides from there.
      cancel: publishCancellable ? send({ kind: "Uploads", command: { type: "cancel" } }) : undefined,
    },
    mapFolder !== null && {
      id: "map-install",
      label: t(mapRemoving ? "status.activity.removingMap" : "status.activity.installingMap", {
        name: mapName ?? mapFolder,
      }),
      progress: mapInstallProgress,
      // A half-deleted map is worse than either, so a removal runs out.
      cancel: mapRemoving
        ? undefined
        : send({ kind: "Maps", command: { type: "cancelInstall", payload: { folderName: mapFolder } } }),
    },
    modUid !== null && {
      id: "mod-install",
      label: t(modRemoving ? "status.activity.removingMod" : "status.activity.installingMod", {
        name: modInstallName ?? modUid,
      }),
      progress: modInstallProgress,
      cancel: modRemoving
        ? undefined
        : send({ kind: "Mods", command: { type: "cancelInstall", payload: { uid: modUid } } }),
    },
    modToggle !== null && {
      id: "mod-toggle",
      label: t("status.activity.togglingMod", { name: modToggle }),
      progress: null,
    },
    updateVersion !== null && {
      id: "client-update",
      label: t("status.activity.downloadingUpdate", { version: updateVersion }),
      progress: updatePercent,
      cancel: send({ kind: "ClientUpdate", command: { type: "cancelDownload" } }),
    },
    galacticWar !== null && {
      id: "galactic-war",
      label: t("status.activity.installingGalacticWar", { version: galacticWar }),
      progress: galacticWarPercent,
    },
    tutorialStep !== null && {
      id: "tutorial",
      label: t("status.activity.preparingTutorial", { detail: tutorialStep }),
      progress: null,
    },
    mapGeneration !== null && {
      id: "map-generation",
      label: mapGeneration,
      progress: mapGenerationPercent,
      cancel: send({ kind: "MapGenerator", command: { type: "cancel" } }),
    },
    mapSearch && { id: "map-search", label: t("maps.view.searching"), progress: null },
    modSearch && { id: "mod-search", label: t("mods.view.searching"), progress: null },
    replaySearch && { id: "replay-search", label: t("replays.vault.searching"), progress: null },
    mapScan && { id: "map-scan", label: t("maps.view.scanning"), progress: null },
    modScan && { id: "mod-scan", label: t("mods.installed.scanning"), progress: null },
    mapVault && { id: "map-vault", label: t("maps.view.loadingVault"), progress: null },
    modVault && { id: "mod-vault", label: t("mods.view.loadingVault"), progress: null },
    leaderboards && { id: "leaderboards", label: t("leaderboard.view.loadingCatalog"), progress: null },
    events && { id: "events", label: t("events.loading"), progress: null },
    tournaments && { id: "tournaments", label: t("tournaments.loading"), progress: null },
    changelog && { id: "changelog", label: t("changelog.loading"), progress: null },
  ];
  return activities.filter((activity): activity is BackgroundActivity => activity !== false);
}

/**
 * The first background activity with its bar and, when it can be stopped, its
 * Cancel; and how many more are running behind it.
 */
export function BackgroundActivityTask({ activities }: { activities: BackgroundActivity[] }) {
  const { t } = useTranslation();
  const [first, ...rest] = activities;
  // The rest are named on hover rather than dropped: "+2" alone would say
  // that something is happening without saying what.
  const title = rest.length > 0
    ? `${first.label}. ${t("status.activity.alsoRunning")}: ${rest.map((activity) => activity.label).join(", ")}`
    : first.label;
  return (
    <div className="client-status-task" aria-live="polite" data-activity={first.id}>
      <span className="client-status-task-label" title={title}>{first.label}</span>
      <TaskProgress label={first.label} progress={first.progress} />
      {rest.length > 0 && (
        <span className="client-status-task-more" title={title}>+{rest.length}</span>
      )}
      {first.cancel && (
        <TaskCancel label={t("status.activity.cancel", { task: first.label })} onCancel={first.cancel} />
      )}
    </div>
  );
}

/**
 * The matchmaker, wherever the player is in the client.
 *
 * Searching was only visible inside the matchmaker panel, so a ladder player
 * who queued and went to Chat or Replays had no sign it was still running and
 * no way to stop it short of going back. This is the fixed place for both.
 */
export function MatchmakingTask({
  state,
  queues,
}: {
  state: Exclude<AppState["lobby"]["matchmaking"], { type: "idle" } | { type: "cancelled" }>;
  queues: AppState["lobby"]["matchmakerQueues"];
}) {
  const { t } = useTranslation();
  // "2 vs 2", the way the queue cards name them, rather than "tmm2v2".
  const named = (queueName: string) => {
    const queue = queues.find((candidate) => candidate.queueName === queueName);
    return queue ? t("status.matchmaking.queue", { size: queue.teamSize }) : queueName;
  };
  if (state.type === "matchFound") {
    return (
      <div className="client-status-task is-attention" role="status" aria-live="assertive">
        <span className="client-status-task-label">
          <strong>{t("status.matchmaking.found", { queue: named(state.payload.queueName) })}</strong>
        </span>
      </div>
    );
  }
  // Preparing (#390) is the first half of a search: the featured mod and the
  // pool maps come down before the server is asked. It can be stopped the
  // same way, as the matchmaker panel does.
  const searching = state.type === "searching" || state.type === "preparing";
  const label = state.type === "preparing"
    ? t("lobby.matchmaker.summary.preparing")
    : state.type === "searching"
      ? t("status.matchmaking.searching", { queues: state.payload.queueNames.map(named).join(", ") })
      : t("status.matchmaking.launching", { queue: named(state.payload.queueName) });
  const stop = () => {
    if (state.type !== "searching" && state.type !== "preparing") return;
    state.payload.queueNames.forEach((queueName) =>
      ipc.send({ kind: "Lobby", command: { type: "matchmake", payload: { queueName, start: false } } }),
    );
  };
  // No progress bar: a search has no progress to measure, and an endless
  // sweep in the corner where downloads report theirs read as one that never
  // finished. The Play tab's dot says it instead, and the same dot leads the
  // line here, coloured by the same states.
  return (
    <div className="client-status-task" aria-live="polite">
      <i className="client-status-search-dot" data-state={state.type} aria-hidden="true" />
      <span className="client-status-task-label" title={label}>{label}</span>
      {searching && (
        <button
          type="button"
          className="client-status-task-action"
          onClick={stop}
          aria-label={t("lobby.matchmaker.stopSearching")}
          title={t("lobby.matchmaker.stopSearching")}
        >
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

export function ClientStatusBar() {
  const { t } = useTranslation();
  const session = useAppStore((state) => state.state.session);
  const player = useAppStore((state) => state.state.auth.player);
  const lobbyStatus = useAppStore((state) => state.state.lobby.status);
  const joinState = useAppStore((state) => state.state.lobby.join);
  const chatStatus = useAppStore((state) => state.state.chat.status);
  const activities = useBackgroundActivities();
  const matchmaking = useAppStore((state) => state.state.lobby.matchmaking);
  const matchmakerQueues = useAppStore((state) => state.state.lobby.matchmakerQueues);
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
    const actionLabel = status === "disconnected" ? t("status.reconnect") : t("status.disconnect");
    const stateLabel = t(STATUS_LABEL[status]);

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
          <span>{t("status.connection.summary", { service: label, state: stateLabel })}</span>
          <span className="client-status-chevron" aria-hidden="true" />
        </button>
        {isOpen && (
          <div className="client-status-popover" id={`client-status-menu-${kind}`} role="menu">
            <div className="client-status-popover-heading">
              <span className="client-status-popover-dot" data-status={status} aria-hidden="true" />
              <span>{t("status.connection.heading", { service: label })}</span>
            </div>
            {/* The state and the thing you can do about it, side by side and the
                same size. They used to be a word tucked into the heading and a
                full-width menu row, which read as one item with a caption: the
                pair is what the popover is actually for. */}
            <div className="client-status-popover-row">
              <span className="client-status-state" data-status={status}>{stateLabel}</span>
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
          </div>
        )}
      </div>
    );
  };

  return (
    <footer ref={rootRef} className="client-status-bar" aria-label={t("status.bar.aria")}>
      <span className="client-status-version">v{session.backendVersion || "0.8.0"}</span>
      {joinState.type === "preparing"
        ? <GamePreparationStatus state={joinState} />
        : joinTaskVisible
          ? <GameJoinStatus state={joinState} />
          : matchmaking.type !== "idle" && matchmaking.type !== "cancelled"
            ? <MatchmakingTask state={matchmaking} queues={matchmakerQueues} />
            : activities.length > 0
              ? <BackgroundActivityTask activities={activities} />
              : null}
      <div className="client-status-connections">
        {renderConnectionMenu("faf", lobbyStatus, "FAF")}
        {renderConnectionMenu("chat", chatStatus, t("status.service.chat"))}
      </div>
    </footer>
  );
}
