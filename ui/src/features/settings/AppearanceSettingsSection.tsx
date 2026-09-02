import type { AppearancePreferences, UiDensity } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { ThemePicker } from "./ThemePicker";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: AppearancePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setAppearance", payload: { preferences } } });

/** Within `MIN_UI_SCALE`/`MAX_UI_SCALE` in the domain, which clamps anything else. */
const UI_SCALES = [100, 125, 150, 175] as const;

const TILE_COLUMN_OPTIONS = [
  { value: 0, labelKey: "settings.appearance.tileColumnsAuto" as const },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
  { value: 6, label: "6" },
] as const;

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
      <SettingRow
        label={t("settings.appearance.interfaceScale")}
        hint={t("settings.appearance.interfaceScaleHint")}
      >
        <div className="settings-segmented surface" role="group" aria-label={t("settings.appearance.interfaceScale")}>
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
      <SettingRow
        label={t("settings.appearance.tileColumns")}
        hint={t("settings.appearance.tileColumnsHint")}
      >
        <div className="settings-segmented surface" role="group" aria-label={t("settings.appearance.tileColumns")}>
          {TILE_COLUMN_OPTIONS.map((option) => {
            const isActive = (preferences.gameTileColumns ?? 0) === option.value;
            return (
              <button
                type="button"
                key={option.value}
                className={isActive ? "is-active" : ""}
                aria-pressed={isActive}
                onClick={() => void save({ ...preferences, gameTileColumns: option.value })}
              >
                {"labelKey" in option ? t(option.labelKey) : option.label}
              </button>
            );
          })}
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
