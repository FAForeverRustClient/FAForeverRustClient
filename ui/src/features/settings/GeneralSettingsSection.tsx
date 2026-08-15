import type { GeneralPreferences, Tab } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow } from "./SettingControls";
import { LOCALES, LOCALE_KEYS, type Locale } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { TABS } from "../nav/tabs";

// Start pages are the tabs a session can open on. The labels come from the tab
// registry so this list cannot drift out of step with the tab bar's wording.
const START_PAGES: Tab[] = [
  "news",
  "chat",
  "play",
  "replays",
  "maps",
  "mods",
  "leaderboard",
  "tournaments",
  "tutorials",
];

const save = (preferences: GeneralPreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setGeneral", payload: { preferences } } });

export function GeneralSettingsSection() {
  const preferences = useAppStore((state) => state.state.settings.general);
  const { t, locale, setLocale } = useTranslation();

  return (
    <>
      <SettingRow
        label={t("settings.general.startPage.label")}
        hint={t("settings.general.startPage.hint")}
      >
        <select
          className="settings-select"
          value={preferences.startPage}
          onChange={(event) => void save({ ...preferences, startPage: event.target.value as Tab })}
          aria-label={t("settings.general.startPage.label")}
        >
          {START_PAGES.map((page) => (
            <option key={page} value={page}>{t(TABS[page].label)}</option>
          ))}
        </select>
      </SettingRow>

      {/* Frontend-only for now: the language is read back from localStorage on
          the next start. It moves into the backend Settings slice when the
          backend's own user-facing strings are keyed too. */}
      <SettingRow
        label={t("settings.general.language.label")}
        hint={t("settings.general.language.hint")}
      >
        <select
          className="settings-select"
          value={locale}
          onChange={(event) => { setLocale(event.target.value as Locale); }}
          aria-label={t("settings.general.language.label")}
        >
          {LOCALE_KEYS.map((key) => (
            <option key={key} value={key}>{LOCALES[key].name}</option>
          ))}
        </select>
      </SettingRow>
    </>
  );
}
