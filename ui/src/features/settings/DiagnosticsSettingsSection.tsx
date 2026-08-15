import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { native, type LogKind, type LogPreview } from "../../ipc/native";
import { SettingRow } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

export function DiagnosticsSettingsSection() {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<LogPreview | null>(null);
  const [error, setError] = useState("");
  const openFolder = (kind: LogKind) => {
    setError("");
    void native.openLogFolder(kind).catch((reason) => setError(String(reason)));
  };
  const viewLatest = (kind: LogKind) => {
    setError("");
    void native.readLatestLog(kind)
      .then((result) => result ? setPreview(result) : setError(t("settings.diagnostics.noLogs")))
      .catch((reason) => setError(String(reason)));
  };

  return (
    <>
      <SettingRow label={t("settings.diagnostics.gameLogs")} hint={t("settings.diagnostics.gameLogsHint")}>
        <div className="settings-diagnostic-actions">
          <Button onClick={() => viewLatest("game")}>{t("settings.diagnostics.viewLatest")}</Button>
          <Button onClick={() => openFolder("game")}>{t("settings.diagnostics.openFolder")}</Button>
        </div>
      </SettingRow>
      <SettingRow label={t("settings.diagnostics.clientLogs")} hint={t("settings.diagnostics.clientLogsHint")}>
        <div className="settings-diagnostic-actions">
          <Button onClick={() => viewLatest("client")}>{t("settings.diagnostics.viewLatest")}</Button>
          <Button onClick={() => openFolder("client")}>{t("settings.diagnostics.openFolder")}</Button>
        </div>
      </SettingRow>
      {error && <p className="settings-inline-error" role="alert">{error}</p>}
      {preview && (
        <Modal className="diagnostic-log-modal" onClose={() => setPreview(null)}>
          <h2>{preview.fileName}</h2>
          <p className="muted">{t("settings.diagnostics.truncated")}</p>
          <textarea readOnly value={preview.content} aria-label={`Contents of ${preview.fileName}`} />
          <div className="settings-diagnostic-actions">
            <Button onClick={() => void navigator.clipboard.writeText(preview.content)}>{t("settings.diagnostics.copy")}</Button>
            <Button variant="primary" onClick={() => setPreview(null)}>{t("settings.diagnostics.close")}</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
