import { useState } from "react";
import { Button } from "../../design-system/Button";
import { FOLDER_GROUPS, openFolderEntry, type FolderEntry } from "../game-folders/gameFolders";
import { SettingRow } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * The client folders, next to the paths they are resolved from.
 *
 * The same list the sidebar's Game folders button opens, read from the one
 * catalogue both share: this row is the one you want while you are configuring
 * a path and want to see what you just pointed at, and that button is the one
 * you want from anywhere else.
 */
export function FoldersSettingsSection() {
  const { t } = useTranslation();
  const [error, setError] = useState("");

  const clientFolders = FOLDER_GROUPS.find((group) => group.id === "client")?.entries ?? [];
  const open = (entry: FolderEntry) => {
    setError("");
    void openFolderEntry(entry).catch((reason) => setError(String(reason)));
  };

  return (
    <>
      <SettingRow label={t("settings.folders.label")} hint={t("settings.folders.hint")}>
        <div className="settings-diagnostic-actions">
          {clientFolders.map((entry) => (
            <Button key={entry.id} onClick={() => open(entry)}>
              {t(entry.label)}
            </Button>
          ))}
        </div>
      </SettingRow>
      {error && <p className="settings-inline-error" role="alert">{error}</p>}
    </>
  );
}
