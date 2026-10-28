// "You are still searching for a match" (#650).
//
// Mounted in the shell beside `JoinDownloadDialog`, for the same reason: a
// join starts from the play tab, the chat, a player menu or a party, and the
// question has to appear wherever the player is. Two answers, as the thread
// settled them: stop the search and join, or do not join and keep searching.

import { useSyncExternalStore } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import { useTranslation } from "../../../i18n/useTranslation";
import { stopSearchingAndJoin } from "../../../shared/joinGame";
import { searchJoinSnapshot, setSearchJoin, subscribeSearchJoin } from "../../../shared/joinWhileSearching";
import "../game-dialogs.css";

export function JoinWhileSearchingDialog() {
  const { t } = useTranslation();
  const pending = useSyncExternalStore(subscribeSearchJoin, searchJoinSnapshot, () => null);
  if (!pending) return null;

  const stay = () => setSearchJoin(null);
  const join = () => void stopSearchingAndJoin(pending.id, pending.password, pending.queueNames);

  return (
    <Modal className="confirm-modal" onClose={stay}>
      <div className="confirm-dialog-content">
        <h2>{t("lobby.joinWhileSearching.title")}</h2>
        <p>
          {pending.title
            ? t("lobby.joinWhileSearching.body", { title: pending.title })
            : t("lobby.joinWhileSearching.bodyUntitled")}
        </p>
        <div className="confirm-dialog-actions">
          <Button onClick={stay}>{t("lobby.joinWhileSearching.cancel")}</Button>
          <Button variant="primary" onClick={join}>
            {t("lobby.joinWhileSearching.confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
