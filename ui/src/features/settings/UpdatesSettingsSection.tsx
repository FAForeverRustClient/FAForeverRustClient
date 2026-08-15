import type { ClientUpdateState, UpdatePreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { isUpdateBusy } from "../../store/reducers/clientUpdate";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import "../updates/updates.css";
import { t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: UpdatePreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setUpdates", payload: { preferences } },
  });

const checkNow = () => ipc.send({ kind: "ClientUpdate", command: { type: "check" } });

export function UpdatesSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((s) => s.state.settings.updates);
  const update = useAppStore((s) => s.state.clientUpdate);

  return (
    <>
      <SettingRow
        label={t("settings.updates.checkUpdatesAt")}
        hint={t("settings.updates.checkUpdatesAtHint")}
      >
        <SettingsSwitch
          checked={preferences.automatic}
          onChange={(automatic) => void save({ ...preferences, automatic })}
          label={t("settings.updates.checkUpdatesAt")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.updates.includePreReleases")}
        hint={t("settings.updates.includePreReleasesHint")}
      >
        <SettingsSwitch
          checked={preferences.preRelease}
          onChange={(preRelease) => void save({ ...preferences, preRelease })}
          label={t("settings.updates.includePreReleases")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.updates.updateStatus")}
        hint={t("settings.updates.updateStatusHint")}
        className="setting-row-update-status"
      >
        <div className="update-settings-status">
          <Button onClick={() => void checkNow()} disabled={isUpdateBusy(update.status)}>
            {t(update.status.type === "checking" ? "settings.updates.checking" : "settings.updates.checkNow")}
          </Button>
          <span>{describe(update)}</span>
        </div>
      </SettingRow>
    </>
  );
}

function describe(update: ClientUpdateState): string {
  const running = update.currentVersion
    ? t("settings.updates.running", { version: update.currentVersion })
    : t("settings.updates.versionUnknown");
  switch (update.status.type) {
    case "idle":
      return `${running}: not checked yet`;
    case "checking":
      return running;
    case "upToDate":
      return `${running}: up to date`;
    case "available":
    case "downloading":
    case "ready":
    case "installing":
      return `${running}: ${update.release?.version ?? "a newer version"} is available`;
    case "failed":
      // Shown here even when the banner stays hidden: a background check that
      // keeps failing should be discoverable somewhere rather than nowhere.
      return `${running}: ${update.status.payload.reason}`;
  }
}
