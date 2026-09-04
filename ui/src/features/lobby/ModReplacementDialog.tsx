// Asks whether the mod versions a game needs may replace the ones already
// installed. Mounted in the shell rather than a tab, because a join starts
// from the play tab, the chat, a player menu or a Discord invite, and the
// prompt has to appear wherever the user happens to be.
//
// The client never deletes an installed mod on its own: preparation stops with
// `needsModReplacement` having changed nothing, and answering here re-sends the
// same join with the approval attached.

import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { joinReplacingMods } from "./joinGame";
import "./game-dialogs.css";

const decline = () => ipc.send({ kind: "Lobby", command: { type: "declineModReplacement" } });

export function ModReplacementDialog() {
  const { t } = useTranslation();
  const join = useAppStore((state) => state.state.lobby.join);

  if (join.type !== "needsModReplacement") return null;
  const { id, conflicts } = join.payload;

  return (
    <Modal className="confirm-modal mod-replace-modal" onClose={decline}>
      <div className="confirm-dialog-content">
        <h2>{t("lobby.modConflict.title")}</h2>
        <p>{t("lobby.modConflict.body", { count: conflicts.length })}</p>
        <ul className="mod-replace-list">
          {conflicts.map((conflict) => (
            <li key={conflict.folderName} className="mod-replace-row">
              <strong>{conflict.requiredName}</strong>
              <span className="muted">
                {t("lobby.modConflict.replaces", {
                  installed: conflict.installedName,
                  version: conflict.installedVersion || "?",
                  folder: conflict.folderName,
                })}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted">{t("lobby.modConflict.note")}</p>
        <div className="confirm-dialog-actions">
          <Button onClick={decline}>{t("lobby.modConflict.cancel")}</Button>
          <Button variant="primary" onClick={() => void joinReplacingMods(id)}>
            {t("lobby.modConflict.confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
