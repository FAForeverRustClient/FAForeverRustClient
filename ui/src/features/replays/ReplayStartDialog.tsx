// What the client is doing between "watch" and Forged Alliance appearing.
//
// The Play tab has narrated this for a while (`JoinPreparationDialog`), and
// the report was that the replay tabs narrate nothing: you press Watch, the
// client fetches the file, decompresses it, opens a relay and starts a game,
// and the only thing that says so is one line of text above the list. Starting
// a replay is several seconds of exactly that silence.
//
// So this is the same overlay for the same wait, with what the replay slice
// actually knows in it. It has no steps and no percentage, because the replay
// port reports neither: `Connecting` is the whole of the narration until the
// game is either up or has failed. A bar that sweeps says "running" without
// claiming to know how far along it is.
//
// Two ways out, because they are different things. Hide gets the overlay off
// the screen and leaves the launch running, which is what it always did and
// what the note under it says. Cancel stops the launch: the client is several
// awaits deep in fetching and preparing a file at that point, and dropping
// that work is the only thing that ends the wait rather than covering it up.
//
// Cancel is gone once the game has the file, since there is nothing left to
// call off by then -- but so is this whole overlay, which only stands while
// the status is `connecting`.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { useTranslation } from "../../i18n/useTranslation";
import { ipc } from "../../ipc/client";
import { plainError } from "../../shared/plainError";
import { LaunchProgress, type LaunchContext } from "../../shared/components/LaunchProgress";
import { mapPresentation } from "../../shared/mapPresentation";
import type { ReplayLaunch } from "../../ipc/bindings";
import { replayLaunchContext } from "./replayLaunchContext";
import { useAppStore } from "../../store/store";
import "./replays.css";

const cancelWatch = () =>
  ipc.send({ kind: "Replays", command: { type: "cancelWatch" } });

/** "Do not show again": the setting the Game settings row turns back on. */
const stopShowing = () =>
  ipc.send({ kind: "Settings", command: { type: "patchGame", payload: { patch: { showReplayProgress: false } } } });

export function ReplayStartDialog() {
  const { t } = useTranslation();
  const status = useAppStore((state) => state.state.replays.status);
  // What is being fetched right now: an old engine build can be dozens of
  // files on a slow line, and a bar alone read as stuck (#392).
  const preparing = useAppStore((state) => state.state.replays.preparing);
  const [hidden, setHidden] = useState(false);
  // Off, the status bar narrates the start alone, and a failure is still
  // read in the notification centre, where `fail` always puts it.
  const enabled = useAppStore((state) => state.state.settings.game.showReplayProgress ?? true);
  // The lists that can name the replay being started. Read here rather than
  // in the pure lookup so the dialog redraws when the one it needs arrives.
  const vault = useAppStore((state) => state.state.replays.vault);
  const recentMatchmaker = useAppStore((state) => state.state.replays.recentMatchmaker);
  const liveGames = useAppStore((state) => state.state.lobby.liveGames);
  const local = useAppStore((state) => state.state.replays.local);
  const maps = useAppStore((state) => state.state.maps.vault);
  // A failure carries no launch of its own; the one it ended is kept, so the
  // head still says which replay did not start.
  const lastLaunch = useRef<ReplayLaunch | null>(null);
  if (status.type === "connecting") lastLaunch.current = status.payload.launch;
  // A failure is only this dialog's to report when this dialog is the reason
  // the user is waiting. The live tab refuses a game that started four minutes
  // ago without anything having been started, and that answer belongs on the
  // button that was pressed, not in a modal over the whole client.
  const announced = useRef(false);

  useEffect(() => {
    if (status.type === "connecting") {
      announced.current = true;
      setHidden(false);
      return;
    }
    if (status.type !== "failed") announced.current = false;
  }, [status]);

  const failed = status.type === "failed" && announced.current;
  if (!enabled || hidden || (status.type !== "connecting" && !failed)) return null;
  const percent = preparing?.progress == null ? null : Math.min(100, Math.max(0, preparing.progress));

  const close = () => {
    announced.current = false;
    setHidden(true);
  };

  const reason = failed && status.type === "failed" ? status.payload.reason : null;
  const launch = status.type === "connecting" ? status.payload.launch : lastLaunch.current;
  const found = launch && replayLaunchContext(launch, { vault, recentMatchmaker, liveGames, local });
  const context: LaunchContext | null = found && {
    name: found.title ?? found.fileName ?? t("replays.starting.unnamed", { uid: found.uid ?? "" }),
    mapName: found.map,
    mapUrl: found.mapUrl,
    // The id first: it is what the user asked to see, and what a bug report
    // about this replay needs.
    detail: [
      // Already the name when no list here knows the replay's title.
      found.uid !== null && (found.title || found.fileName) ? `#${found.uid}` : null,
      found.map ? mapPresentation(maps, found.map).displayName : null,
      found.live ? t("replays.source.live") : null,
    ].filter(Boolean).join(" · ") || null,
  };

  return (
    <LaunchProgress
      className="replay-starting-modal"
      onClose={close}
      title={t(failed ? "replays.starting.failedTitle" : "replays.starting.title")}
      context={context}
      vault={maps}
      icon={failed ? "alert" : "replays"}
      iconTone={failed ? "error" : undefined}
      subtitle={failed ? null : t("replays.starting.detail")}
      // What is being fetched right now, filled when the step in hand is
      // measured (the replay's own download, an engine file), a sweep
      // otherwise.
      phase={preparing?.detail}
      percent={percent}
      showBar={!failed}
      progressLabel={t("replays.starting.title")}
      progressText={percent === null ? t("replays.starting.detail") : `${percent}%`}
      // A failure plainly, with the launcher's own words on hover for a bug
      // report: they can name paths and `os error` numbers.
      notice={reason === null ? null : { tone: "error", text: plainError(reason), title: reason }}
      footStart={failed ? null : (
        <Button
          className="launch-progress-dismiss"
          title={t("replays.starting.dontShowAgainHint")}
          onClick={() => {
            void stopShowing();
            close();
          }}
        >
          {t("replays.starting.dontShowAgain")}
        </Button>
      )}
      actions={failed ? (
        <Button variant="primary" onClick={close}>{t("replays.starting.close")}</Button>
      ) : (
        <>
          <Button
            onClick={() => {
              cancelWatch();
              close();
            }}
          >
            {t("replays.starting.cancel")}
          </Button>
          <Button variant="primary" onClick={close}>{t("replays.starting.hide")}</Button>
        </>
      )}
    />
  );
}
