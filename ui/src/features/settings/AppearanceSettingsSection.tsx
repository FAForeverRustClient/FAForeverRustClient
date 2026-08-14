import type { AppearancePreferences, UiDensity } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { ThemePicker } from "./ThemePicker";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: AppearancePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setAppearance", payload: { preferences } } });

export function AppearanceSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.appearance);

  return (
    <>
      <div className="setting-block">
        <span className="setting-label">{t("settings.appearance.theme")}</span>
        <span className="muted">{t("settings.appearance.themeHint")}</span>
        <ThemePicker />
      </div>
      <SettingRow label={t("settings.appearance.interfaceDensity")} hint={t("settings.appearance.interfaceDensityHint")}>
        <div className="settings-segmented surface" role="group" aria-label={t("settings.appearance.interfaceDensity")}>
          {(["compact", "comfortable"] as UiDensity[]).map((density) => (
            <button
              type="button"
              key={density}
              className={preferences.density === density ? "is-active" : ""}
              aria-pressed={preferences.density === density}
              onClick={() => void save({ ...preferences, density })}
            >
              {t(density === "compact" ? "settings.appearance.compact" : "settings.appearance.comfortable")}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label={t("settings.appearance.reduceMotion")} hint={t("settings.appearance.reduceMotionHint")}>
        <SettingsSwitch
          checked={preferences.reduceMotion}
          onChange={(reduceMotion) => void save({ ...preferences, reduceMotion })}
          label={t("settings.appearance.reduceMotion")}
        />
      </SettingRow>
    </>
  );
}
