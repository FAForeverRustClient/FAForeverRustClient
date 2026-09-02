import { useState } from "react";
import { Button } from "../../design-system/Button";
import { native, type ClientFolder } from "../../ipc/native";
import { SettingRow } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

export function FoldersSettingsSection() {
  const { t } = useTranslation();
  const [error, setError] = useState("");

  const CLIENT_FOLDERS: ClientFolder[] = ["maps", "mods", "replays", "vault", "gameCache", "gamePrefs"];
  const openClientFolder = (kind: ClientFolder) => {
    setError("");
    void native.openClientFolder(kind).catch((reason) => setError(String(reason)));
  };

  return (
    <>
      <SettingRow label={t("settings.folders.label")} hint={t("settings.folders.hint")}>
        <div className="settings-diagnostic-actions">
          {CLIENT_FOLDERS.map((kind) => (
            <Button key={kind} onClick={() => openClientFolder(kind)}>
              {t(`settings.folders.${kind}`)}
            </Button>
          ))}
        </div>
      </SettingRow>
      {error && <p className="settings-inline-error" role="alert">{error}</p>}
    </>
  );
}
