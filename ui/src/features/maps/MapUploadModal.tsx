import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { InstalledMap, UploadsState } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { isUploadBusy } from "../../store/reducers/uploads";
import { useAppStore } from "../../store/store";
import { EmptyState } from "../../design-system/EmptyState";
import { useTranslation, type Translation } from "../../i18n/useTranslation";
import { isOfficialMap, MapPreview, sizeLabel } from "./MapVaultComponents";

const closeUpload = () => ipc.send({ kind: "Uploads", command: { type: "close" } });
const setRanked = (ranked: boolean) =>
  ipc.send({ kind: "Uploads", command: { type: "setRanked", payload: { ranked } } });
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

export function MapUploadModal({
  installed,
  initialMap,
  onClose,
}: {
  installed: InstalledMap[];
  initialMap?: InstalledMap | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const uploadsState = useAppStore((store) => store.state.uploads);
  const customMaps = useMemo(
    () =>
      installed
        .filter((m) => !isOfficialMap(m.folderName))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [installed],
  );

  const [selectedFolder, setSelectedFolder] = useState<string>(
    initialMap?.folderName || customMaps[0]?.folderName || "",
  );
  const [rankedPreference, setRankedPreference] = useState(false);
  const [agreedToRules, setAgreedToRules] = useState(false);

  const selectedMap = useMemo(
    () => customMaps.find((m) => m.folderName.toLowerCase() === selectedFolder.toLowerCase()) ?? null,
    [customMaps, selectedFolder],
  );

  const busy = isUploadBusy(uploadsState.status);
  const done = uploadsState.status.type === "succeeded";
  const failed = uploadsState.status.type === "failed";
  const progress = statusProgress(uploadsState.status, t);

  // Sync ranked setting with domain when modal opens or selection changes
  useEffect(() => {
    if (uploadsState.request?.kind === "map") {
      setRankedPreference(uploadsState.request.ranked);
    }
  }, [uploadsState.request]);

  const handleRankedChange = (checked: boolean) => {
    setRankedPreference(checked);
    if (uploadsState.request) {
      setRanked(checked);
    }
  };

  const handlePublish = () => {
    if (!selectedMap || !agreedToRules || busy) return;
    ipc.send({
      kind: "Uploads",
      command: {
        type: "open",
        payload: {
          request: {
            kind: "map",
            folderName: selectedMap.folderName,
            displayName: selectedMap.displayName,
            ranked: rankedPreference,
          },
        },
      },
    });
    // Start upload immediately after opening request
    setTimeout(() => {
      startUpload();
    }, 50);
  };

  const handleClose = () => {
    closeUpload();
    onClose();
  };

  return (
    <Modal className="map-upload-modal" onClose={handleClose}>
      <header className="map-upload-head">
        <h2>{t("uploads.title.map")}</h2>
        <p className="muted">{t("maps.upload.intro")}</p>
      </header>

      <div className="map-upload-body">
        {customMaps.length === 0 ? (
          <EmptyState
            bordered
            icon="maps"
            title={t("maps.upload.noCustomMaps")}
            hint={t("maps.upload.noCustomMapsHint")}
          />
        ) : (
          <>
            <div className="map-upload-field">
              <label htmlFor="map-upload-select" className="map-upload-label">
                Select map to publish
              </label>
              <select
                id="map-upload-select"
                className="search-panel-control map-upload-select"
                value={selectedFolder}
                disabled={busy || done}
                onChange={(e) => setSelectedFolder(e.target.value)}
              >
                {customMaps.map((map) => (
                  <option key={map.folderName} value={map.folderName}>
                    {map.displayName} ({map.folderName})
                  </option>
                ))}
              </select>
            </div>

            {selectedMap && (
              <div className="map-upload-preview-card surface">
                <div className="map-upload-thumb-wrap">
                  <MapPreview map={selectedMap} large />
                </div>
                <div className="map-upload-meta">
                  <h3>{selectedMap.displayName}</h3>
                  <p className="muted map-upload-folder-text">{selectedMap.folderName}</p>
                  <div className="map-upload-tags">
                    <span className="surface-chip">{sizeLabel(selectedMap)}</span>
                    <span className="surface-chip">{selectedMap.maxPlayers ?? 2} players</span>
                    {selectedMap.version && <span className="surface-chip">v{selectedMap.version}</span>}
                  </div>
                  {selectedMap.description && (
                    <p className="map-upload-description muted">{selectedMap.description}</p>
                  )}
                </div>
              </div>
            )}

            <div className="map-upload-options">
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={rankedPreference}
                  disabled={busy || done}
                  onChange={(e) => handleRankedChange(e.target.checked)}
                />
                <span>
                  <strong>{t("uploads.allowRanked")}</strong>
                  <small className="muted display-block">
                    Enable this if the map is balanced and suitable for competitive ranked matchmaker / ladder games.
                  </small>
                </span>
              </label>

              <label className="check-field map-upload-rules-check">
                <input
                  type="checkbox"
                  checked={agreedToRules}
                  disabled={busy || done}
                  onChange={(e) => setAgreedToRules(e.target.checked)}
                />
                <span>
                  <strong>I agree to the FAF Map Vault Rules</strong>
                  <small className="muted display-block">
                    I verify that this map contains no offensive, abusive, or copyrighted material, and complies with FAF community guidelines.
                  </small>
                </span>
              </label>
            </div>

            {progress && (
              <div className={`map-upload-progress-box ${failed ? "is-error" : ""}`}>
                <div className="map-upload-progress-info">
                  <span>{progress.label}</span>
                </div>
                {progress.percent !== null && (
                  <div className="map-upload-progress-bar">
                    <div
                      className="map-upload-progress-fill"
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {done && (
              <div className="map-upload-success-box surface is-ok">
                <Icon name="star" size={20} />
                <div>
                  <strong>{t("uploads.published")}</strong>
                  <p className="muted">Your map has been uploaded and registered with the vault.</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="map-upload-actions">
        <Button onClick={handleClose}>{t(done ? "uploads.close" : "uploads.cancel")}</Button>
        {!done && customMaps.length > 0 && (
          <Button
            variant="primary"
            disabled={!selectedMap || !agreedToRules || busy}
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
