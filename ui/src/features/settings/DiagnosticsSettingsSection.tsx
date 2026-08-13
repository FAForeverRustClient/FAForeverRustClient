import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { native, type LogKind, type LogPreview } from "../../ipc/native";
import { SettingRow } from "./SettingControls";

export function DiagnosticsSettingsSection() {
  const [preview, setPreview] = useState<LogPreview | null>(null);
  const [error, setError] = useState("");
  const openFolder = (kind: LogKind) => {
    setError("");
    void native.openLogFolder(kind).catch((reason) => setError(String(reason)));
  };
  const viewLatest = (kind: LogKind) => {
    setError("");
    void native.readLatestLog(kind)
      .then((result) => result ? setPreview(result) : setError("No logs have been created yet."))
      .catch((reason) => setError(String(reason)));
  };

  return (
    <>
      <SettingRow label="Game logs" hint="Each game, tutorial, replay and live replay keeps its own diagnostic log; the newest 50 are retained.">
        <div className="settings-diagnostic-actions">
          <Button onClick={() => viewLatest("game")}>View latest</Button>
          <Button onClick={() => openFolder("game")}>Open folder</Button>
        </div>
      </SettingRow>
      <SettingRow label="Client logs" hint="Rolling client diagnostics are retained separately from Forged Alliance logs.">
        <div className="settings-diagnostic-actions">
          <Button onClick={() => viewLatest("client")}>View latest</Button>
          <Button onClick={() => openFolder("client")}>Open folder</Button>
        </div>
      </SettingRow>
      {error && <p className="settings-inline-error" role="alert">{error}</p>}
      {preview && (
        <Modal className="diagnostic-log-modal" onClose={() => setPreview(null)}>
          <h2>{preview.fileName}</h2>
          <p className="muted">Showing at most the newest 512 KiB.</p>
          <textarea readOnly value={preview.content} aria-label={`Contents of ${preview.fileName}`} />
          <div className="settings-diagnostic-actions">
            <Button onClick={() => void navigator.clipboard.writeText(preview.content)}>Copy</Button>
            <Button variant="primary" onClick={() => setPreview(null)}>Close</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
