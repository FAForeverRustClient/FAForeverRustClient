// "Joining this lobby will download these mods. Still want to?"
//
// Mounted in the shell rather than in a tab, for the same reason
// `ModReplacementDialog` is: a join starts from the play tab, the chat, a
// player menu or a party invite, and the question has to appear wherever the
// user happens to be.
//
// The one thing it cannot tell you is the download size. The API's mod
// resource carries a download URL but no file length, so the honest options
// were to say nothing about size or to fire a HEAD request per mod before
// showing a dialog. It says nothing, and names what will arrive instead.

import { useState, useSyncExternalStore } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import type { GamePreferences } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { confirmPendingJoin } from "./joinGame";
import { pendingJoinSnapshot, setPendingJoin, subscribePendingJoin } from "./joinConfirmation";
import "./game-dialogs.css";

const saveGamePreferences = (preferences: GamePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setGame", payload: { preferences } } });

export function JoinDownloadDialog() {
  const { t } = useTranslation();
  const pending = useSyncExternalStore(subscribePendingJoin, pendingJoinSnapshot, () => null);
  const game = useAppStore((state) => state.state.settings.game);
  // Ticking the box is not the decision; pressing Join is. Kept in component
  // state so cancelling never changes a setting, and reset with the dialog.
  const [remember, setRemember] = useState(false);

  if (!pending) return null;

  const cancel = () => {
    setRemember(false);
    setPendingJoin(null);
  };
  const join = () => {
    // The checkbox is the setting. Somebody who has just been shown the list
    // and pressed Join has made exactly the decision the setting encodes, and
    // asking them to find it among the game options afterwards is asking them
    // to do the same thing twice.
    if (remember) {
      saveGamePreferences({ ...game, confirmDownloadsBeforeJoining: false });
    }
    setRemember(false);
    void confirmPendingJoin(pending.id, pending.password);
  };

  return (
    <Modal className="confirm-modal join-download-modal" onClose={cancel}>
      <div className="confirm-dialog-content">
        <h2>{t("lobby.joinDownload.title")}</h2>
        <p>{t("lobby.joinDownload.body", { count: pending.missingMods.length, title: pending.title })}</p>
        <ul className="join-download-list">
          {pending.missingMods.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <p className="muted">{t("lobby.joinDownload.sizeNote")}</p>
        <div className="confirm-dialog-actions join-download-actions">
          <label className="option-check join-download-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            {t("lobby.joinDownload.dontAskAgain")}
          </label>
          <span className="join-download-buttons">
            <Button onClick={cancel}>{t("lobby.joinDownload.cancel")}</Button>
            <Button variant="primary" onClick={join}>
              {t("lobby.joinDownload.confirm")}
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
