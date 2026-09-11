// What stands between the Upload button and the file picker.
//
// Two things came out of the thread. The one everybody agreed on is that the
// button opened an OS file browser the instant it was pressed, with nothing in
// between: somebody pressing it out of curiosity to see what uploading even
// involves got their filesystem on screen, which for anyone streaming is their
// filesystem on screen in front of an audience.
//
// The other is the vault rules. An upload is public and it is somebody else's
// job to moderate, so the rules are worth a link and worth a deliberate press
// rather than a page nobody finds until after the fact.
//
// Deliberately not here: a "how does modding work" tutorial. That was the part
// of the thread that did not converge, and the argument against it holds --
// somebody at the point of uploading a mod has already made one, and the
// client is not the wiki.

import { useState } from "react";

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import type { UploadKind } from "../../ipc/bindings";
import "./upload-intro.css";

/** The vault rules, which an uploader is agreeing to. */
const VAULT_RULES_URL = "https://wiki.faforever.com/en/Development/Vault/Rules";

export function UploadIntroDialog({
  kind,
  onCancel,
  onContinue,
}: {
  kind: UploadKind;
  onCancel: () => void;
  /** Opens the file picker. Only reachable once the box is ticked. */
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const [accepted, setAccepted] = useState(false);
  const isMap = kind === "map";

  return (
    <Modal
      className="upload-intro-dialog"
      ariaLabel={t(isMap ? "uploads.intro.titleMap" : "uploads.intro.titleMod")}
      onClose={onCancel}
    >
      <h2>{t(isMap ? "uploads.intro.titleMap" : "uploads.intro.titleMod")}</h2>
      <p>{t(isMap ? "uploads.intro.bodyMap" : "uploads.intro.bodyMod")}</p>

      <button
        type="button"
        className="upload-intro-rules"
        onClick={() => ipc.run(openHttpsUrl(VAULT_RULES_URL))}
      >
        <Icon name="external" size={14} />
        {t("uploads.intro.rulesLink")}
      </button>

      <label className="upload-intro-accept">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>{t("uploads.intro.accept")}</span>
      </label>

      <div className="upload-intro-actions">
        <Button onClick={onCancel}>{t("uploads.intro.cancel")}</Button>
        {/* The picker is one more press, which is the point: it is what stops
            the file browser appearing on a stream because somebody wondered
            what the button did. */}
        <Button variant="primary" disabled={!accepted} onClick={onContinue}>
          {t("uploads.intro.selectFolder")}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * The Upload button's behaviour: the gate first, the picker second.
 *
 * A hook rather than wiring the state into both vault views, which are large
 * and have nothing else to say about it. `start` goes on the button and
 * `dialog` goes anywhere in the view's tree.
 */
export function useUploadIntro(kind: UploadKind, onAccepted: () => void) {
  const [open, setOpen] = useState(false);
  return {
    start: () => setOpen(true),
    dialog: open ? (
      <UploadIntroDialog
        kind={kind}
        onCancel={() => setOpen(false)}
        onContinue={() => {
          setOpen(false);
          onAccepted();
        }}
      />
    ) : null,
  };
}
