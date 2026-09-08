// Renaming one of your own mods, from the vault entry itself.
//
// FAF has no rename. A mod is its `uid`, the vault refuses a second upload
// carrying one it already holds, and an author who wanted a different name had
// to edit `mod_info.lua`, invent a fresh uid, re-zip the folder and upload the
// result by hand. All of that is mechanical, so the client does it.
//
// This asks for the one thing it cannot work out, then hands the request to
// the ordinary upload dialog: the confirmation, the two progress stages and
// the failures are the same ones every other publish shows, and there is no
// second copy of them here.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * Open the upload dialog with a rename attached.
 *
 * Dispatching `open` and letting the global dialog take it from there, rather
 * than starting the publish outright: `start` reads the request out of state,
 * and the two commands are dispatched onto separate tasks, so firing both
 * would be a race. The user pressing Publish is what orders them.
 */
function openRename(installed: InstalledMod, newName: string) {
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
          // Installed, so the backend finds the folder itself.
          sourcePath: null,
          renameTo: newName,
        },
      },
    },
  });
}

export function ModRenameDialog({
  mod,
  installed,
  onClose,
}: {
  mod: VaultMod;
  installed: InstalledMod;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(mod.displayName);

  const trimmed = name.trim();
  const unchanged = trimmed === mod.displayName.trim();
  const ready = trimmed !== "" && !unchanged;

  return (
    <Modal className="confirm-modal" onClose={onClose}>
      <form
        className="confirm-dialog-content"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          openRename(installed, trimmed);
          onClose();
        }}
      >
        <h2>{t("mods.rename.title", { name: mod.displayName })}</h2>
        <p className="muted">{t("mods.rename.hint")}</p>

        <label className="mod-rename-field">
          <span>{t("mods.rename.newName")}</span>
          <input
            className="search-panel-control"
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {unchanged && <p className="muted">{t("mods.rename.same")}</p>}

        <div className="confirm-dialog-actions">
          <Button type="button" onClick={onClose}>
            {t("mods.vault.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {t("mods.rename.submit")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
