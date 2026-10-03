import type { DiscordPreferencesPatch } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

const save = (patch: DiscordPreferencesPatch) =>
  ipc.send({
    kind: "Settings",
    command: { type: "patchDiscord", payload: { patch } },
  });

export function DiscordSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.discord);
  const update = (patch: DiscordPreferencesPatch) => void save(patch);

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
