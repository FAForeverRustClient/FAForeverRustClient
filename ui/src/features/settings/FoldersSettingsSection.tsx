import { useState } from "react";
import { Button } from "../../design-system/Button";
import { StatusNotice } from "../../design-system/StatusNotice";
import { FOLDER_GROUPS, openFolderEntry, type FolderEntry } from "../../shared/gameFolders";
import { plainError } from "../../shared/plainError";
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
  // The folder that would not open, and the shell's reason why.
  const [failure, setFailure] = useState<{ entry: FolderEntry; reason: string } | null>(null);

  const clientFolders = FOLDER_GROUPS.find((group) => group.id === "client")?.entries ?? [];
  const open = (entry: FolderEntry) => {
    setFailure(null);
    void openFolderEntry(entry).catch((reason) => setFailure({ entry, reason: String(reason) }));
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
      {/* Plainly, with the shell's own words ("could not open C:\...\maps:
          ...") on hover, and Retry opening the same folder. */}
      {failure && (
        <StatusNotice
          tone="error"
          className="settings-inline-notice"
          action={{ label: t("common.retry"), onClick: () => open(failure.entry) }}
          detail={failure.reason}
        >
          {plainError(failure.reason)}
        </StatusNotice>
      )}
    </>
  );
}
