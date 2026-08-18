// Confirm before closing the client while Forged Alliance is running.
//
// Mirrors the Java client's `exitWarning`. The consequence here is at least as
// bad as there: closing takes the lobby connection, the ICE adapter and the
// GPGNet relay down with it, so a game in progress loses its connectivity, not
// just its chat.
//
// The check is a state read rather than a process probe: `JoinState::InGame`
// means the launch chain reported the game process started, and the launcher's
// game-exit watcher clears it again.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { native } from "../../ipc/native";
import { useTranslation } from "../../i18n/useTranslation";

export function ExitGuard() {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void native
      .onRequestExitConfirm(() => {
        setAsking(true);
      })
      .then((unlisten) => {
        dispose = unlisten;
      });
    return () => dispose?.();
  }, []);

  if (!asking) return null;

  return (
    <Modal onClose={() => setAsking(false)}>
      <h2 className="exit-guard-title">{t("shell.exitGuard.title")}</h2>
      <p className="muted exit-guard-body">{t("shell.exitGuard.body")}</p>
      <div className="exit-guard-actions">
        <Button onClick={() => setAsking(false)}>{t("shell.exitGuard.keepOpen")}</Button>
        <Button
          variant="primary"
          onClick={() => {
            setAsking(false);
            void native.exitApp();
          }}
        >
          {t("shell.exitGuard.closeAnyway")}
        </Button>
      </div>
    </Modal>
  );
}
