// What the client is doing between "join" and the game window appearing.
//
// The backend has narrated this for a while (`JoinState::Preparing` carries a
// step and a percentage), but the only place it showed was one line in the
// status bar at the very bottom of the window, and the report was blunt about
// how that reads: nothing appears to happen. Patching a featured mod is
// hundreds of files and a map is a fresh download, so "nothing" can last a
// while.
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
import "./game-dialogs.css";

export function JoinPreparationDialog() {
  const { t } = useTranslation();
  const join = useAppStore((state) => state.state.lobby.join);
  const preparing = join.type === "preparing" ? join.payload : null;
  const detail = preparing?.detail ?? "";

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
    if (!preparing) {
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
    setSteps((current) => (
      // The backend repeats the same step with a new percentage, which is one
      // step, not a hundred.
      current[current.length - 1] === detail || detail === "" ? current : [...current, detail]
    ));
  }, [preparing, detail]);

  if (!preparing || hidden) return null;

  const progress = preparing.progress === null
    ? null
    : Math.min(100, Math.max(0, preparing.progress));

  return (
    <Modal className="confirm-modal join-preparing-modal" onClose={() => setHidden(true)}>
      <div className="confirm-dialog-content">
        <h2>{t("lobby.joinProgress.title")}</h2>
        {/* Which of the four kinds of waiting this is. The Python client gives
            each its own bar; one bar plus the name of the phase driving it
            says the same thing without four mostly-empty bars, and it is what
            stops the long silent checksum pass reading as a hang. */}
        <p className="join-preparing-phase">{t(`lobby.joinProgress.phase.${preparing.phase}`)}</p>
        <p className="join-preparing-detail">{preparing.detail}</p>
        <div
          className="join-preparing-bar"
          data-indeterminate={progress === null ? "true" : undefined}
          role="progressbar"
          aria-label={t("lobby.joinProgress.title")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
          aria-valuetext={progress === null ? preparing.detail : `${preparing.detail}, ${progress}%`}
        >
          <span style={progress === null ? undefined : { width: `${progress}%` }} />
        </div>
        <p className="muted join-preparing-percent">
          {progress === null ? t("lobby.joinProgress.working") : `${progress}%`}
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
          <Button onClick={() => setHidden(true)}>{t("lobby.joinProgress.hide")}</Button>
        </div>
        <p className="muted join-preparing-note">{t("lobby.joinProgress.hideNote")}</p>
      </div>
    </Modal>
  );
}
