// Renaming one of your own mods, from the vault entry itself.
//
// Two different things share this dialog, and which one happens is the
// server's answer rather than a choice made here.
//
// The first is an actual rename: `PATCH /data/mod/{id}` changing
// `displayName`. `Mod.displayName` carries no update restriction in the API's
// own model, unlike `recommended`, which is annotated for administrators, so
// this is worth asking for. It changes the entry that already exists, which is
// what anybody means by "rename".
//
// The second is the fallback, and it is what FAF's own authors have always had
// to do by hand: a mod is its `uid`, the vault refuses a second upload
// carrying one it already holds, so publishing a renamed copy under a fresh
// uid leaves the old entry standing beside the new one. That is a duplicate,
// not a rename, and it is offered only once the server has refused the real
// thing.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";

const renameInPlace = (modId: number, displayName: string) =>
  ipc.send({
    kind: "Mods",
    command: { type: "renameVaultMod", payload: { modId, displayName } },
  });

/**
 * The fallback: open the upload dialog with a rename attached.
 *
 * Dispatching `open` and letting the global dialog take it from there rather
 * than starting the publish outright: `start` reads the request out of state,
 * and the two commands are dispatched onto separate tasks, so firing both
 * would be a race. The user pressing Publish is what orders them.
 */
const openRepublish = (installed: InstalledMod, newName: string) =>
  ipc.send({
    kind: "Uploads",
    command: {
      type: "open",
      payload: {
        request: {
          kind: "mod",
          folderName: installed.folderName,
          displayName: newName,
          ranked: false,
          sourcePath: null,
          renameTo: newName,
        },
      },
    },
  });

export function ModRenameDialog({
  mod,
  installed,
  onClose,
}: {
  mod: VaultMod;
  installed: InstalledMod | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const status = useAppStore((state) => state.state.mods.renameStatus);
  const [name, setName] = useState(mod.displayName);

  const trimmed = name.trim();
  const unchanged = trimmed === mod.displayName.trim();
  const ready = trimmed !== "" && !unchanged;

  const mine = status.type !== "idle" && status.payload.modId === mod.modId;
  const working = mine && status.type === "renaming";
  const failed = mine && status.type === "failed" ? status.payload : null;

  // Closes itself once the entry has actually been renamed: the list behind
  // this dialog already shows the new name, so there is nothing left to read.
  useEffect(() => {
    if (mine && status.type === "renamed") onClose();
  }, [mine, status.type, onClose]);

  return (
    <Modal className="confirm-modal" onClose={onClose}>
      <form
        className="confirm-dialog-content"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !working) renameInPlace(mod.modId, trimmed);
        }}
      >
        <h2>{t("mods.rename.title", { name: mod.displayName })}</h2>

        <label className="mod-rename-field">
          <span>{t("mods.rename.newName")}</span>
          <input
            className="search-panel-control"
            value={name}
            disabled={working}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {unchanged && <p className="muted">{t("mods.rename.same")}</p>}

        {failed && (
          <div className="mod-rename-refusal">
            <p className="upload-status is-error">{failed.reason}</p>
            {/* Only a refusal means FAF will not do this at all. Anything else
                did not get there, and the same button is worth pressing
                again. */}
            {failed.refused && (
              <p className="muted">
                {t(installed ? "mods.rename.refusedHint" : "mods.rename.refusedNeedsInstall")}
              </p>
            )}
          </div>
        )}

        <div className="confirm-dialog-actions">
          <Button type="button" onClick={onClose}>
            {t("mods.vault.cancel")}
          </Button>
          {failed?.refused && installed && (
            <Button
              type="button"
              onClick={() => {
                openRepublish(installed, trimmed);
                onClose();
              }}
            >
              {t("mods.rename.republish")}
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!ready || working}>
            {t(working ? "mods.rename.working" : "mods.rename.submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
