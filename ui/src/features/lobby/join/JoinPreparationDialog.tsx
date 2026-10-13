// What the client is doing between "join" and the game window appearing.
//
// The backend has narrated this for a while (`JoinState::Preparing` carries a
// step and a percentage), but the only place it showed was one line in the
// status bar at the very bottom of the window, and the report was blunt about
// how that reads: nothing appears to happen. Patching a featured mod is
// hundreds of files and a map is a fresh download, so "nothing" can last a
// while.
//
// It stays up past the patching, too. Preparation used to be the whole of it:
// the moment the files were ready the dialog closed, and the wait that follows
// -- the adapter starting, Forged Alliance opening its window, which is a good
// few seconds on any machine -- was narrated by one line at the bottom of the
// window reading "Initiating". The report was that the client looks like it
// stopped. So `launched` keeps the dialog, saying the game is starting, until
// the game itself is on screen.
//
// Dismissible on purpose. A dialog that cannot be closed while a five minute
// patch runs is a client you cannot use, and the status bar keeps the same
// narration once this is out of the way. Closing hides the dialog; it does not
// stop the preparation, and the text says so.
//
// While the game starts it also names the ICE adapter, when that is not the
// usual Java one or when the setting and the host disagree. A game hosted on Go
// needs Go on every side, and `Dynamic` already follows the host there without
// a word, so a join that suddenly behaves differently had nothing to explain
// it. One line here rather than a notification of its own, which is where the
// maintainers wanted it (issue #467).

import { useEffect, useRef, useState } from "react";
import { Button } from "../../../design-system/Button";
import type { Game, GameLaunch } from "../../../ipc/bindings";
import { useAppStore } from "../../../store/store";
import { useTranslation } from "../../../i18n/useTranslation";
import { ipc } from "../../../ipc/client";
import { splitGoAdapterTitle } from "../../../shared/goAdapterTitle";
import { lastJoinRequestId } from "../../../shared/joinGame";
import { mapPresentation } from "../../../shared/mapPresentation";
import { LaunchProgress, type LaunchContext } from "../../../shared/components/LaunchProgress";
import { adapterNoteOf, joinProgressOf, nextStep } from "./joinProgress";
import "../game-dialogs.css";

/**
 * Call the join off.
 *
 * One command for both halves of the dialog: while the files are coming down
 * it stops the preparation and the join request, and once the game process is
 * up the service turns it into the same termination the Leave button does.
 * Which of the two applies is a question about state the backend already holds.
 */
const cancelJoin = () => ipc.send({ kind: "Lobby", command: { type: "cancelJoin" } });

/** "Do not show again": the setting the Game settings row turns back on. */
const stopShowing = () =>
  ipc.send({ kind: "Settings", command: { type: "patchGame", payload: { patch: { showJoinProgress: false } } } });

export function JoinPreparationDialog() {
  const { t } = useTranslation();
  const join = useAppStore((state) => state.state.lobby.join);
  const joinAdapter = useAppStore((state) => state.state.settings.connectivity.adapter);
  // Off, the status bar narrates the join alone.
  const enabled = useAppStore((state) => state.state.settings.game.showJoinProgress ?? true);
  const games = useAppStore((state) => state.state.lobby.games);
  const vault = useAppStore((state) => state.state.maps.vault);
  const matchmakerLaunching = useAppStore((state) => state.state.lobby.matchmaking.type === "launching");
  const launch = join.type === "launched" ? join.payload.launch : null;
  // A matchmaker game is launched first and prepared after, and the launch
  // order is the only thing that names its map. Kept for the preparation
  // that follows it.
  const launchSeen = useRef<GameLaunch | null>(null);
  if (launch) launchSeen.current = launch;
  const progress = joinProgressOf(join);
  // The line the step log follows. While the game is starting there is no
  // detail to follow, so the log stops growing and keeps what it has.
  const detail = progress?.kind === "preparing" ? progress.detail : "";

  const [hidden, setHidden] = useState(false);
  // The steps already done, which is the "Details" the report asked for. Held
  // here rather than in the domain: it is a log of what this dialog has seen,
  // it means nothing once the dialog is gone, and the alternative is a growing
  // Vec in `AppState` that every snapshot would carry for the rest of the
  // session.
  const [steps, setSteps] = useState<string[]>([]);
  const wasPreparing = useRef(false);

  useEffect(() => {
    if (!progress) {
      // Reset on the way out, not on the way in: the first render with a step
      // in it must not throw that step away.
      if (wasPreparing.current) {
        wasPreparing.current = false;
        setHidden(false);
        setSteps([]);
        launchSeen.current = null;
      }
      return;
    }
    wasPreparing.current = true;
    setSteps((current) => {
      const line = nextStep(current, detail);
      return line === null ? current : [...current, line];
    });
  }, [progress, detail]);

  if (!progress || hidden || !enabled) return null;

  // Starting the game has nothing to measure: the client has handed off to a
  // process and is waiting for a window, so the bar runs rather than fills.
  const percent = progress.kind === "preparing" ? progress.progress : null;
  // Only once the launch order is in: its title is what the backend reads to
  // pick the adapter, and before it the dialog has no title to read.
  const adapterNote = progress.kind === "starting" ? adapterNoteOf(joinAdapter, progress.name) : null;
  const starting = progress.kind === "starting";
  const stage = starting ? 2 : progress.phase === "map" ? 1 : 0;
  const context = contextOf(
    starting ? launch : launchSeen.current,
    matchmakerLaunching ? null : games.find((game) => game.id === lastJoinRequestId()) ?? null,
    (map) => mapPresentation(vault, map).displayName,
  );
  const phase = starting
    ? t("lobby.joinProgress.phase.starting")
    : t(`lobby.joinProgress.phase.${progress.phase}`);

  return (
    <LaunchProgress
      className="join-preparing-modal"
      onClose={() => setHidden(true)}
      title={t(starting ? "lobby.joinProgress.startingTitle" : "lobby.joinProgress.title")}
      context={context}
      vault={vault}
      // Which of the four kinds of waiting this is. The Python client gives
      // each its own bar; one bar plus the name of the phase driving it says
      // the same thing without four mostly-empty bars, and it is what stops
      // the long silent checksum pass reading as a hang.
      phase={phase}
      percent={percent}
      stages={{
        labels: [
          t("lobby.joinProgress.stage.files"),
          t("lobby.joinProgress.stage.map"),
          t("lobby.joinProgress.stage.game"),
        ],
        current: stage,
      }}
      progressLabel={t("lobby.joinProgress.title")}
      progressText={percent === null ? detail || phase : `${detail || phase}, ${percent}%`}
      detail={starting ? t("lobby.joinProgress.startingNote") : progress.detail}
      detailIsText={starting}
      // Says in words what the title's mark said, which is why the mark is
      // gone from the name above, as it is in the game browser.
      notice={adapterNote && {
        tone: adapterNote === "hostOnGo" ? "info" : "warn",
        text: t(`lobby.joinProgress.adapter.${adapterNote}`),
      }}
      // The reference client's "Details" button: which file, which step, and
      // how far through the list of them this is.
      log={steps}
      logLabels={{
        show: (count) => t("lobby.joinProgress.showDetails", { count }),
        hide: t("lobby.joinProgress.hideDetails"),
      }}
      footStart={
        <Button
          className="launch-progress-dismiss"
          title={t("lobby.joinProgress.dontShowAgainHint")}
          onClick={() => {
            void stopShowing();
            setHidden(true);
          }}
        >
          {t("lobby.joinProgress.dontShowAgain")}
        </Button>
      }
      actions={
        <>
          {/* Stop, not just look away. Hiding leaves the join running, which
              is the right default for a five minute patch, and is no use at
              all to somebody who has changed their mind about the game. */}
          <Button onClick={cancelJoin}>
            {t(starting ? "lobby.joinProgress.cancelStarting" : "lobby.joinProgress.cancel")}
          </Button>
          <Button variant="primary" onClick={() => setHidden(true)}>{t("lobby.joinProgress.hide")}</Button>
        </>
      }
    />
  );
}

/**
 * What the head names: the launch order once there is one, otherwise the
 * lobby the last join was sent for.
 */
function contextOf(
  launch: GameLaunch | null,
  game: Game | null,
  mapLabel: (map: string) => string,
): LaunchContext | null {
  if (launch) {
    return {
      name: splitGoAdapterTitle(launch.name).title,
      mapName: launch.mapname || null,
      detail: launch.mapname ? mapLabel(launch.mapname) : null,
    };
  }
  if (game) {
    return {
      name: splitGoAdapterTitle(game.title).title,
      mapName: game.map || null,
      detail: game.map ? mapLabel(game.map) : null,
    };
  }
  return null;
}
