import type { DiscordPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: DiscordPreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setDiscord", payload: { preferences } },
  });

export function DiscordSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.discord);
  const update = (patch: Partial<DiscordPreferences>) => void save({ ...preferences, ...patch });

  return (
    <>
      <SettingRow
        label={t("settings.discord.richPresence")}
        hint={t("settings.discord.richPresenceHint")}
      >
        <SettingsSwitch
          checked={preferences.enabled}
          onChange={(enabled) => update({ enabled })}
          label={t("settings.discord.richPresence")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.discord.disallowJoinsVia")}
        hint={t("settings.discord.disallowJoinsViaHint")}
      >
        <SettingsSwitch
          checked={preferences.disallowJoins}
          disabled={!preferences.enabled}
          onChange={(disallowJoins) => update({ disallowJoins })}
          label={t("settings.discord.disallowJoinsVia")}
        />
      </SettingRow>
    </>
  );
}
