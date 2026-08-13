import type { AppearancePreferences, UiDensity } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { ThemePicker } from "./ThemePicker";

const save = (preferences: AppearancePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setAppearance", payload: { preferences } } });

export function AppearanceSettingsSection() {
  const preferences = useAppStore((state) => state.state.settings.appearance);

  return (
    <>
      <div className="setting-block">
        <span className="setting-label">Theme</span>
        <span className="muted">Choose a built-in color system. Changes apply immediately.</span>
        <ThemePicker />
      </div>
      <SettingRow label="Interface density" hint="Comfortable adds space; compact shows more at once.">
        <div className="settings-segmented surface" role="group" aria-label="Interface density">
          {(["compact", "comfortable"] as UiDensity[]).map((density) => (
            <button
              type="button"
              key={density}
              className={preferences.density === density ? "is-active" : ""}
              aria-pressed={preferences.density === density}
              onClick={() => void save({ ...preferences, density })}
            >
              {density === "compact" ? "Compact" : "Comfortable"}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Reduce motion" hint="Minimize non-essential animation and transition effects.">
        <SettingsSwitch
          checked={preferences.reduceMotion}
          onChange={(reduceMotion) => void save({ ...preferences, reduceMotion })}
          label="Reduce motion"
        />
      </SettingRow>
    </>
  );
}
