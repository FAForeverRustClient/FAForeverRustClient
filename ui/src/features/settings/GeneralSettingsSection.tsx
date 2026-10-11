import type {
  Tab,
  WeekStart,
  GeneralPreferencesPatch,
  EventsPreferencesPatch,
  FilterMemory,
} from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { LOCALES, LOCALE_KEYS, type Locale } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { TABS } from "../nav/tabs";
import { filterMemoryChanged } from "../../shared/filterMemory";

const FILTER_MEMORY: FilterMemory[] = ["never", "session", "restart"];

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
  "events",
  "training",
];

const save = (patch: GeneralPreferencesPatch) =>
  ipc.send({ kind: "Settings", command: { type: "patchGeneral", payload: { patch } } });

/**
 * The calendar's two preferences.
 *
 * Here rather than in a section of their own: one is a week start and the other
 * is a list somebody manages from the Events tab, and a section holding two
 * rows would be another tab to look through for them.
 */
const saveEvents = (patch: EventsPreferencesPatch) =>
  ipc.send({ kind: "Settings", command: { type: "patchEvents", payload: { patch } } });

export function GeneralSettingsSection() {
  const preferences = useAppStore((state) => state.state.settings.general);
  const events = useAppStore((state) => state.state.settings.events);
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
          onChange={(event) => void save({ startPage: event.target.value as Tab })}
          aria-label={t("settings.general.startPage.label")}
        >
          {START_PAGES.map((page) => (
            <option key={page} value={page}>{t(TABS[page].label)}</option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t("settings.general.autoLogin.label")}
        hint={t("settings.general.autoLogin.hint")}
      >
        <SettingsSwitch
          checked={preferences.autoLogin ?? true}
          onChange={(checked) => void save({ autoLogin: checked })}
          label={t("settings.general.autoLogin.label")}
        />
      </SettingRow>

      <SettingRow
        label={t("settings.general.rememberTypedEntries.label")}
        hint={t("settings.general.rememberTypedEntries.hint")}
      >
        <SettingsSwitch
          checked={preferences.rememberTypedEntries ?? false}
          onChange={(checked) => void save({ rememberTypedEntries: checked })}
          label={t("settings.general.rememberTypedEntries.label")}
        />
      </SettingRow>

      {/* One answer for every list in the client (#447). */}
      <SettingRow
        label={t("settings.general.filterMemory.label")}
        hint={t("settings.general.filterMemory.hint")}
      >
        <select
          className="settings-select"
          value={preferences.filterMemory ?? "session"}
          onChange={(event) => {
            const next = event.target.value as FilterMemory;
            void save({ filterMemory: next });
            filterMemoryChanged(next);
          }}
          aria-label={t("settings.general.filterMemory.label")}
        >
          {FILTER_MEMORY.map((memory) => (
            <option key={memory} value={memory}>{t(`settings.general.filterMemory.${memory}`)}</option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t("settings.events.weekStart.label")}
        hint={t("settings.events.weekStart.hint")}
      >
        <select
          className="settings-select"
          value={events.weekStart}
          onChange={(event) =>
            void saveEvents({ weekStart: event.target.value as WeekStart })
          }
          aria-label={t("settings.events.weekStart.label")}
        >
          <option value="monday">{t("settings.events.weekStart.monday")}</option>
          <option value="sunday">{t("settings.events.weekStart.sunday")}</option>
        </select>
      </SettingRow>

      <SettingRow
        label={t("settings.events.reminders.label")}
        hint={t("settings.events.reminders.hint")}
      >
        {events.reminders.length === 0 ? (
          <span className="muted">{t("settings.events.reminders.none")}</span>
        ) : (
          <div className="settings-diagnostic-actions">
            <span className="muted">
              {t("settings.events.reminders.count", { count: events.reminders.length })}
            </span>
            <Button onClick={() => void saveEvents({ reminders: [] })}>
              {t("settings.events.reminders.clear")}
            </Button>
          </div>
        )}
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
