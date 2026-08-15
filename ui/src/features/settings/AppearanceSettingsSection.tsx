import type { AppearancePreferences, UiDensity } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { ThemePicker } from "./ThemePicker";

const save = (preferences: AppearancePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setAppearance", payload: { preferences } } });

/** Within `MIN_UI_SCALE`/`MAX_UI_SCALE` in the domain, which clamps anything else. */
const UI_SCALES = [100, 125, 150, 175] as const;

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
      <SettingRow
        label="Interface scale"
        hint="Scales the whole client. Useful on a high-resolution display running at 100% desktop scaling, where the default size is physically small."
      >
        <div className="settings-segmented surface" role="group" aria-label="Interface scale">
          {UI_SCALES.map((scale) => (
            <button
              type="button"
              key={scale}
              className={preferences.uiScale === scale ? "is-active" : ""}
              aria-pressed={preferences.uiScale === scale}
              onClick={() => void save({ ...preferences, uiScale: scale })}
            >
              {scale}%
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
