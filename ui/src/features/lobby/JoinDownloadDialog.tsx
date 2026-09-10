// "Joining this lobby will download these mods. Still want to?"
//
// Mounted in the shell rather than in a tab, for the same reason
// `ModReplacementDialog` is: a join starts from the play tab, the chat, a
// player menu or a party invite, and the question has to appear wherever the
// user happens to be.
//
// The size is the one number the API does not carry: its `mod` resource has a
// download URL and no file length. So the dialog opens on the names, which it
// knows immediately, and asks the backend for one HEAD per archive; the total
// appears a moment later. Nothing waits on it, and a mod nothing came back for
// turns the total into an "at least" rather than quietly leaving itself out.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import type { GamePreferences, ModDownloadTarget } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { confirmPendingJoin } from "./joinGame";
import {
  missingModsSize,
  pendingJoinSnapshot,
  setPendingJoin,
  subscribePendingJoin,
} from "./joinConfirmation";
import { formatBytes } from "../../shared/formatBytes";
import "./game-dialogs.css";

const saveGamePreferences = (preferences: GamePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setGame", payload: { preferences } } });

export function JoinDownloadDialog() {
  const { t } = useTranslation();
  const pending = useSyncExternalStore(subscribePendingJoin, pendingJoinSnapshot, () => null);
  const game = useAppStore((state) => state.state.settings.game);
  const vault = useAppStore((state) => state.state.mods.vault);
  const sizes = useAppStore((state) => state.state.mods.downloadSizes);

  // The download URLs come from the vault the store already mirrors, so the
  // backend is handed a list of things to measure rather than asked to look
  // anything up: same shape as the install command, and it keeps the service
  // free of state reads.
  const targets = useMemo<ModDownloadTarget[]>(() => {
    if (!pending) return [];
    const byUid = new Map(vault.map((mod) => [mod.uid.toLocaleLowerCase(), mod]));
    return pending.missingMods.flatMap((mod) => {
      const found = byUid.get(mod.uid.toLocaleLowerCase());
      return found?.downloadUrl ? [{ uid: mod.uid, downloadUrl: found.downloadUrl }] : [];
    });
  }, [pending, vault]);

  useEffect(() => {
    // Only the ones nothing is known about yet: the answers live in the store
    // for the session, so reopening the dialog on the same lobby asks nothing.
    const unmeasured = targets.filter((target) => sizes[target.uid] === undefined);
    if (unmeasured.length === 0) return;
    ipc.send({
      kind: "Mods",
      command: { type: "queryDownloadSizes", payload: { targets: unmeasured } },
    });
    // `sizes` deliberately absent: this fires for a new set of targets, not
    // every time an answer lands and shrinks the list it would recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets]);
  // Ticking the box is not the decision; pressing Join is. Kept in component
  // state so cancelling never changes a setting, and reset with the dialog.
  const [remember, setRemember] = useState(false);

  if (!pending) return null;

  const { bytes, unknown } = missingModsSize(pending.missingMods, sizes);
  const measured = pending.missingMods.length - unknown;
  const sizeLine = measured === 0
    ? t("lobby.joinDownload.sizeUnknown")
    : unknown === 0
      ? t("lobby.joinDownload.sizeTotal", { size: formatBytes(bytes) })
      : t("lobby.joinDownload.sizePartial", { size: formatBytes(bytes), unknown });

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
          {pending.missingMods.map((mod) => (
            <li key={mod.uid}>
              <span>{mod.name}</span>
              {sizes[mod.uid] !== undefined && (
                <small className="muted">{formatBytes(sizes[mod.uid])}</small>
              )}
            </li>
          ))}
        </ul>
        <p className="muted">{sizeLine}</p>
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
