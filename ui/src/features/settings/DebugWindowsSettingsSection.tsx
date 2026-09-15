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

function useDebugPreferences() {
  const preferences = useAppStore((state) => state.state.settings.debug);
  return {
    preferences,
    set: (patch: Partial<DebugPreferences>) => void save({ ...preferences, ...patch }),
  };
}

/**
 * The adapter's own three windows.
 *
 * All three are off, which is why they exist at all: the client suppresses
 * every console window its helpers would otherwise raise, and these hand them
 * back to whoever is debugging a connection. They take effect on the next game,
 * not the one in flight.
 *
 * Drawn under Connectivity rather than with the logs, and the difference is
 * when you reach for them. These are switched on *before* a game so you can
 * watch the adapter work, which makes them part of configuring it; a log is
 * read afterwards, once something has already gone wrong.
 */
export function IceDebugWindowsSection() {
  const { t } = useTranslation();
  const { preferences, set } = useDebugPreferences();

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
    </>
  );
}

/**
 * The generator's console window, beside the logs.
 *
 * The one debug window that is opened after the fact: a generator run either
 * produced a map or it did not, and this is how you find out why. That is
 * reading a log by another name, which is the register it belongs to.
 */
export function MapGeneratorWindowSection() {
  const { t } = useTranslation();
  const { preferences, set } = useDebugPreferences();

  return (
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
  );
}
