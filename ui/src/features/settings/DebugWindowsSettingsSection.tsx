import type { DebugPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: DebugPreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setDebug", payload: { preferences } },
  });

/**
 * The diagnostic windows the helper processes may put on screen.
 *
 * All three are off, which is why this section exists: the client suppresses
 * every console window its helpers would otherwise raise, and these hand them
 * back to whoever is debugging a connection or a generator run. They take
 * effect on the next game or the next run, not on the one in flight.
 */
export function DebugWindowsSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.debug);
  const set = (patch: Partial<DebugPreferences>) => void save({ ...preferences, ...patch });

  return (
    <>
      <SettingRow
        label={t("settings.debug.iceAdapterDebugWindow")}
        hint={t("settings.debug.iceAdapterDebugWindowHint")}
      >
        <SettingsSwitch
          checked={preferences.iceAdapterDebugWindow}
          onChange={(iceAdapterDebugWindow) => set({ iceAdapterDebugWindow })}
          label={t("settings.debug.iceAdapterDebugWindow")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.debug.iceAdapterInfoWindow")}
        hint={t("settings.debug.iceAdapterInfoWindowHint")}
      >
        <SettingsSwitch
          checked={preferences.iceAdapterInfoWindow}
          onChange={(iceAdapterInfoWindow) => set({ iceAdapterInfoWindow })}
          label={t("settings.debug.iceAdapterInfoWindow")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.debug.iceAdapterConsoleWindow")}
        hint={t("settings.debug.iceAdapterConsoleWindowHint")}
      >
        <SettingsSwitch
          checked={preferences.iceAdapterConsoleWindow}
          onChange={(iceAdapterConsoleWindow) => set({ iceAdapterConsoleWindow })}
          label={t("settings.debug.iceAdapterConsoleWindow")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.debug.mapGeneratorWindow")}
        hint={t("settings.debug.mapGeneratorWindowHint")}
      >
        <SettingsSwitch
          checked={preferences.mapGeneratorWindow}
          onChange={(mapGeneratorWindow) => set({ mapGeneratorWindow })}
          label={t("settings.debug.mapGeneratorWindow")}
        />
      </SettingRow>
    </>
  );
}
