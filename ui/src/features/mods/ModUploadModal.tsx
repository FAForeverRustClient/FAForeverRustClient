import { useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { InstalledMod, UploadsState } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { isUploadBusy } from "../../store/reducers/uploads";
import { useAppStore } from "../../store/store";
import { EmptyState } from "../../design-system/EmptyState";
import { useTranslation, type Translation } from "../../i18n/useTranslation";
import { ModPreview } from "./ModVaultComponents";

const closeUpload = () => ipc.send({ kind: "Uploads", command: { type: "close" } });
const startUpload = () => ipc.send({ kind: "Uploads", command: { type: "start" } });

function statusProgress(
  status: UploadsState["status"],
  t: Translation["t"],
): { label: string; percent: number | null } | null {
  switch (status.type) {
    case "idle":
      return null;
    case "compressing":
      return { label: t("maps.upload.compressing"), percent: null };
    case "uploading": {
      const { sentBytes, totalBytes } = status.payload;
      const mbSent = (sentBytes / (1024 * 1024)).toFixed(1);
      const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);
      const percent = totalBytes > 0 ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 0;
      return {
        label: t("maps.upload.uploading", { sent: mbSent, total: mbTotal, percent }),
        percent,
      };
    }
    case "finishing":
      return { label: t("maps.upload.finishing"), percent: 100 };
    case "succeeded":
      return null;
    case "failed":
      return { label: status.payload.reason, percent: null };
  }
}

export function ModUploadModal({
  installed,
  initialMod,
  onClose,
}: {
  installed: InstalledMod[];
  initialMod?: InstalledMod | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const uploadsState = useAppStore((store) => store.state.uploads);
  const vault = useAppStore((store) => store.state.mods.vault);

  const customMods = useMemo(
    () => [...installed].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [installed],
  );

  const [selectedFolder, setSelectedFolder] = useState<string>(
    initialMod?.folderName || customMods[0]?.folderName || "",
  );
  const [agreedToRules, setAgreedToRules] = useState(false);

  const selectedMod = useMemo(
    () => customMods.find((m) => m.folderName.toLowerCase() === selectedFolder.toLowerCase()) ?? null,
    [customMods, selectedFolder],
  );

  const vaultMetadata = useMemo(
    () => (selectedMod ? vault.find((v) => v.uid === selectedMod.uid) : null),
    [vault, selectedMod],
  );

  const busy = isUploadBusy(uploadsState.status);
  const done = uploadsState.status.type === "succeeded";
  const failed = uploadsState.status.type === "failed";
  const progress = statusProgress(uploadsState.status, t);

  const handlePublish = () => {
    if (!selectedMod || !agreedToRules || busy) return;
    ipc.send({
      kind: "Uploads",
      command: {
        type: "open",
        payload: {
          request: {
            kind: "mod",
            folderName: selectedMod.folderName,
            displayName: selectedMod.displayName,
            ranked: false,
            // Installed, so there is no archive to point at: the backend finds
            // the folder in the user's mods directory itself.
            sourcePath: null,
          },
        },
      },
    });
    setTimeout(() => {
      startUpload();
    }, 50);
  };

  const handleClose = () => {
    closeUpload();
    onClose();
  };

  return (
    <Modal className="mod-upload-modal" onClose={handleClose}>
      <header className="mod-upload-head">
        <h2>{t("uploads.title.mod")}</h2>
        <p className="muted">
          Select a local mod to package and publish to the FAF Mod Vault.
        </p>
      </header>

      <div className="mod-upload-body">
        {customMods.length === 0 ? (
          <EmptyState
            bordered
            icon="mods"
            title="No local mods found"
            hint="Install or place your mod files in the Supreme Commander mods folder to upload them."
          />
        ) : (
          <>
            <div className="mod-upload-field">
              <label htmlFor="mod-upload-select" className="mod-upload-label">
                Select mod to publish
              </label>
              <select
                id="mod-upload-select"
                className="search-panel-control mod-upload-select"
                value={selectedFolder}
                disabled={busy || done}
                onChange={(e) => setSelectedFolder(e.target.value)}
              >
                {customMods.map((mod) => (
                  <option key={mod.folderName} value={mod.folderName}>
                    {mod.displayName} ({mod.folderName})
                  </option>
                ))}
              </select>
            </div>

            {selectedMod && (
              <div className="mod-upload-preview-card surface">
                <div className="mod-upload-thumb-wrap">
                  {vaultMetadata ? (
                    <ModPreview mod={vaultMetadata} large />
                  ) : (
                    <span className="mod-vault-thumb mod-vault-preview-empty" aria-hidden="true">
                      <Icon name="mods" size={32} />
                    </span>
                  )}
                </div>
                <div className="mod-upload-meta">
                  <h3>{selectedMod.displayName}</h3>
                  <p className="muted mod-upload-folder-text">{selectedMod.folderName}</p>
                  <div className="mod-upload-tags">
                    <span className={`mod-badge mod-badge-${selectedMod.modType}`}>
                      {selectedMod.modType === "ui" ? "UI" : "SIM"}
                    </span>
                    <span className="surface-chip">v{selectedMod.version}</span>
                    {selectedMod.author && (
                      <span className="surface-chip">{selectedMod.author}</span>
                    )}
                  </div>
                  {selectedMod.description && (
                    <p className="mod-upload-description muted">{selectedMod.description}</p>
                  )}
                </div>
              </div>
            )}

            <div className="mod-upload-options">
              <label className="check-field mod-upload-rules-check">
                <input
                  type="checkbox"
                  checked={agreedToRules}
                  disabled={busy || done}
                  onChange={(e) => setAgreedToRules(e.target.checked)}
                />
                <span>
                  <strong>I agree to the FAF Mod Vault Rules</strong>
                  <small className="muted display-block">
                    I verify that this mod contains no offensive, abusive, or malicious code, and complies with FAF community guidelines.
                  </small>
                </span>
              </label>
            </div>

            {progress && (
              <div className={`mod-upload-progress-box ${failed ? "is-error" : ""}`}>
                <div className="mod-upload-progress-info">
                  <span>{progress.label}</span>
                </div>
                {progress.percent !== null && (
                  <div className="mod-upload-progress-bar">
                    <div
                      className="mod-upload-progress-fill"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {done && (
              <div className="mod-upload-success-box surface is-ok">
                <Icon name="star" size={20} />
                <div>
                  <strong>{t("uploads.published")}</strong>
                  <p className="muted">Your mod has been uploaded and registered with the vault.</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="mod-upload-actions">
        <Button onClick={handleClose}>{t(done ? "uploads.close" : "uploads.cancel")}</Button>
        {!done && customMods.length > 0 && (
          <Button
            variant="primary"
            disabled={!selectedMod || !agreedToRules || busy}
            onClick={handlePublish}
          >
            <Icon name="upload" size={15} />
            {t(busy ? "uploads.publishing" : "uploads.publish")}
          </Button>
        )}
      </footer>
    </Modal>
  );
}
