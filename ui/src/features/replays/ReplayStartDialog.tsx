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
import { Modal } from "../../design-system/Modal";
import { useTranslation } from "../../i18n/useTranslation";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import "./replays.css";

const cancelWatch = () =>
  ipc.send({ kind: "Replays", command: { type: "cancelWatch" } });

export function ReplayStartDialog() {
  const { t } = useTranslation();
  const status = useAppStore((state) => state.state.replays.status);
  const [hidden, setHidden] = useState(false);
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
  if (hidden || (status.type !== "connecting" && !failed)) return null;

  const close = () => {
    announced.current = false;
    setHidden(true);
  };

  return (
    <Modal className="confirm-modal replay-starting-modal" onClose={close}>
      <div className="confirm-dialog-content">
        <h2>{t(failed ? "replays.starting.failedTitle" : "replays.starting.title")}</h2>
        <p className="replay-starting-detail">
          {failed && status.type === "failed"
            ? status.payload.reason
            : t("replays.starting.detail")}
        </p>
        {!failed && (
          <div
            className="replay-starting-bar"
            data-indeterminate="true"
            role="progressbar"
            aria-label={t("replays.starting.title")}
            aria-valuetext={t("replays.starting.detail")}
          >
            <span />
          </div>
        )}
        <div className="confirm-dialog-actions">
          {!failed && (
            <Button
              variant="primary"
              onClick={() => {
                cancelWatch();
                close();
              }}
            >
              {t("replays.starting.cancel")}
            </Button>
          )}
          <Button onClick={close}>
            {t(failed ? "replays.starting.close" : "replays.starting.hide")}
          </Button>
        </div>
        {!failed && <p className="muted replay-starting-note">{t("replays.starting.hideNote")}</p>}
      </div>
    </Modal>
  );
}
