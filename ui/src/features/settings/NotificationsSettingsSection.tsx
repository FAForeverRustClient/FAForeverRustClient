import type { NotificationPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";

const save = (preferences: NotificationPreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setNotifications", payload: { preferences } },
  });

export function NotificationsSettingsSection() {
  const preferences = useAppStore((state) => state.state.settings.notifications);
  const update = (patch: Partial<NotificationPreferences>) =>
    void save({ ...preferences, ...patch });

  return (
    <>
      <SettingRow label="Notifications" hint="Show alerts for important activity while the client is open.">
        <SettingsSwitch
          checked={preferences.enabled}
          onChange={(enabled) => update({ enabled })}
          label="Notifications"
        />
      </SettingRow>
      <SettingRow label="Desktop notifications" hint="Use operating-system notifications when the client is in the background.">
        <SettingsSwitch
          checked={preferences.desktop}
          disabled={!preferences.enabled}
          onChange={(desktop) => update({ desktop })}
          label="Desktop notifications"
        />
      </SettingRow>
      <SettingRow label="Notification sounds" hint="Play a short sound for new alerts.">
        <SettingsSwitch
          checked={preferences.sound}
          disabled={!preferences.enabled}
          onChange={(sound) => update({ sound })}
          label="Notification sounds"
        />
      </SettingRow>
      <SettingRow label="Sound volume" hint="Adjust alert volume without changing game audio.">
        <label className="settings-volume">
          <input
            type="range"
            min={0}
            max={100}
            value={preferences.volume}
            disabled={!preferences.enabled || !preferences.sound}
            onChange={(event) => update({ volume: Number(event.target.value) })}
            aria-label="Notification sound volume"
          />
          <span>{preferences.volume}%</span>
        </label>
      </SettingRow>
      <SettingRow label="Notify while focused" hint="Also show desktop alerts while you are actively using the client.">
        <SettingsSwitch
          checked={preferences.notifyWhenFocused}
          disabled={!preferences.enabled || !preferences.desktop}
          onChange={(notifyWhenFocused) => update({ notifyWhenFocused })}
          label="Notify while focused"
        />
      </SettingRow>
      <SettingRow label="Match found" hint="Alert when matchmaking finds a game.">
        <SettingsSwitch checked={preferences.matchFound} disabled={!preferences.enabled} onChange={(matchFound) => update({ matchFound })} label="Match found" />
      </SettingRow>
      <SettingRow label="Private messages" hint="Alert for incoming direct messages.">
        <SettingsSwitch checked={preferences.privateMessages} disabled={!preferences.enabled} onChange={(privateMessages) => update({ privateMessages })} label="Private messages" />
      </SettingRow>
      <SettingRow label="Mentions" hint="Alert when someone mentions your name in a channel.">
        <SettingsSwitch checked={preferences.mentions} disabled={!preferences.enabled} onChange={(mentions) => update({ mentions })} label="Mentions" />
      </SettingRow>
      <SettingRow label="Friends online" hint="Alert when a friend appears online.">
        <SettingsSwitch checked={preferences.friendOnline} disabled={!preferences.enabled} onChange={(friendOnline) => update({ friendOnline })} label="Friends online" />
      </SettingRow>
      <SettingRow label="Friends offline" hint="Alert when a friend disconnects from FAF.">
        <SettingsSwitch checked={preferences.friendOffline} disabled={!preferences.enabled} onChange={(friendOffline) => update({ friendOffline })} label="Friends offline" />
      </SettingRow>
      <SettingRow label="Friends start playing" hint="Alert when a friend enters a live game.">
        <SettingsSwitch checked={preferences.friendPlaying} disabled={!preferences.enabled} onChange={(friendPlaying) => update({ friendPlaying })} label="Friends start playing" />
      </SettingRow>
      <SettingRow label="New custom games" hint="Alert when a new game is hosted after you connect.">
        <SettingsSwitch checked={preferences.newCustomGames} disabled={!preferences.enabled} onChange={(newCustomGames) => update({ newCustomGames })} label="New custom games" />
      </SettingRow>
      <SettingRow label="Friends' games only" hint="Limit new-game alerts to games hosted by friends.">
        <SettingsSwitch checked={preferences.newCustomGamesFriendsOnly} disabled={!preferences.enabled || !preferences.newCustomGames} onChange={(newCustomGamesFriendsOnly) => update({ newCustomGamesFriendsOnly })} label="Friends' games only" />
      </SettingRow>
      <SettingRow label="Game full" hint="Alert when a custom game you host fills its last slot.">
        <SettingsSwitch checked={preferences.gameFull} disabled={!preferences.enabled} onChange={(gameFull) => update({ gameFull })} label="Game full" />
      </SettingRow>
      <SettingRow label="Game launched" hint="Confirm when the game process starts successfully.">
        <SettingsSwitch checked={preferences.gameLaunched} disabled={!preferences.enabled} onChange={(gameLaunched) => update({ gameLaunched })} label="Game launched" />
      </SettingRow>
      <SettingRow label="After-game reminder" hint="Prompt you to review the map or mods after your live game ends.">
        <SettingsSwitch checked={preferences.reviewReminder} disabled={!preferences.enabled} onChange={(reviewReminder) => update({ reviewReminder })} label="After-game reminder" />
      </SettingRow>
      <SettingRow label="Party invitations" hint="Alert when another player invites you to a party.">
        <SettingsSwitch checked={preferences.partyInvites} disabled={!preferences.enabled} onChange={(partyInvites) => update({ partyInvites })} label="Party invitations" />
      </SettingRow>
    </>
  );
}
