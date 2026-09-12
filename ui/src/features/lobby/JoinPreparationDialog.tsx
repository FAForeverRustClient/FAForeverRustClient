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

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { ipc } from "../../ipc/client";
import { joinProgressOf, nextStep } from "./joinProgress";
import "./game-dialogs.css";

/**
 * Call the join off.
 *
 * One command for both halves of the dialog: while the files are coming down
 * it stops the preparation and the join request, and once the game process is
 * up the service turns it into the same termination the Leave button does.
 * Which of the two applies is a question about state the backend already holds.
 */
const cancelJoin = () => ipc.send({ kind: "Lobby", command: { type: "cancelJoin" } });

export function JoinPreparationDialog() {
  const { t } = useTranslation();
  const join = useAppStore((state) => state.state.lobby.join);
  const progress = joinProgressOf(join);
  // The line the step log follows. While the game is starting there is no
  // detail to follow, so the log stops growing and keeps what it has.
  const detail = progress?.kind === "preparing" ? progress.detail : "";

  const [hidden, setHidden] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
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
      }
      return;
    }
    wasPreparing.current = true;
    setSteps((current) => {
      const line = nextStep(current, detail);
      return line === null ? current : [...current, line];
    });
  }, [progress, detail]);

  if (!progress || hidden) return null;

  // Starting the game has nothing to measure: the client has handed off to a
  // process and is waiting for a window, so the bar runs rather than fills.
  const percent = progress.kind === "preparing" ? progress.progress : null;

  return (
    <Modal className="confirm-modal join-preparing-modal" onClose={() => setHidden(true)}>
      <div className="confirm-dialog-content">
        <h2>
          {t(progress.kind === "starting"
            ? "lobby.joinProgress.startingTitle"
            : "lobby.joinProgress.title")}
        </h2>
        {/* Which of the four kinds of waiting this is. The Python client gives
            each its own bar; one bar plus the name of the phase driving it
            says the same thing without four mostly-empty bars, and it is what
            stops the long silent checksum pass reading as a hang. */}
        <p className="join-preparing-phase">
          {progress.kind === "starting"
            ? t("lobby.joinProgress.phase.starting")
            : t(`lobby.joinProgress.phase.${progress.phase}`)}
        </p>
        <p className="join-preparing-detail">
          {progress.kind === "starting"
            ? t("lobby.joinProgress.startingDetail", { name: progress.name })
            : progress.detail}
        </p>
        <div
          className="join-preparing-bar"
          data-indeterminate={percent === null ? "true" : undefined}
          role="progressbar"
          aria-label={t("lobby.joinProgress.title")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-valuetext={percent === null ? detail : `${detail}, ${percent}%`}
        >
          <span style={percent === null ? undefined : { width: `${percent}%` }} />
        </div>
        <p className="muted join-preparing-percent">
          {percent === null
            ? t(progress.kind === "starting"
              ? "lobby.joinProgress.startingNote"
              : "lobby.joinProgress.working")
            : `${percent}%`}
        </p>

        {/* The reference client's "Details" button: which file, which step,
            and how far through the list of them this is. */}
        <button
          type="button"
          className="join-preparing-steps-toggle"
          aria-expanded={showSteps}
          onClick={() => setShowSteps((open) => !open)}
        >
          {t(showSteps ? "lobby.joinProgress.hideDetails" : "lobby.joinProgress.showDetails", {
            count: steps.length,
          })}
        </button>
        {showSteps && (
          <ol className="join-preparing-steps">
            {steps.map((step, index) => (
              <li key={`${index}-${step}`} className={index === steps.length - 1 ? "is-current" : ""}>
                {step}
              </li>
            ))}
          </ol>
        )}

        <div className="confirm-dialog-actions">
          {/* Stop, not just look away. Hiding leaves the join running, which
              is the right default for a five minute patch, and is no use at
              all to somebody who has changed their mind about the game. */}
          <Button onClick={cancelJoin}>
            {t(progress.kind === "starting"
              ? "lobby.joinProgress.cancelStarting"
              : "lobby.joinProgress.cancel")}
          </Button>
          <Button onClick={() => setHidden(true)}>{t("lobby.joinProgress.hide")}</Button>
        </div>
        <p className="muted join-preparing-note">{t("lobby.joinProgress.hideNote")}</p>
      </div>
    </Modal>
  );
}
