import type { DiscordPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";

const save = (preferences: DiscordPreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setDiscord", payload: { preferences } },
  });

export function DiscordSettingsSection() {
  const preferences = useAppStore((state) => state.state.settings.discord);
  const update = (patch: Partial<DiscordPreferences>) => void save({ ...preferences, ...patch });

  return (
    <>
      <SettingRow
        label="Rich Presence"
        hint="Show the game you are hosting or playing on your Discord profile, including its title and player count."
      >
        <SettingsSwitch
          checked={preferences.enabled}
          onChange={(enabled) => update({ enabled })}
          label="Rich Presence"
        />
      </SettingRow>
      <SettingRow
        label="Disallow joins via Discord"
        hint="Keep the status visible, but remove the Join button so nobody can enter your lobby from Discord."
      >
        <SettingsSwitch
          checked={preferences.disallowJoins}
          disabled={!preferences.enabled}
          onChange={(disallowJoins) => update({ disallowJoins })}
          label="Disallow joins via Discord"
        />
      </SettingRow>
    </>
  );
}
