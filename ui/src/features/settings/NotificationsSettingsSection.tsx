import type { NotificationPreferences, ToastPosition } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { recordEntries } from "../../shared/records";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

/* In reading order rather than enum order: the corner the bell is in comes
   first, because it is the default and the one most people will keep. */
const TOAST_POSITIONS: Record<ToastPosition, MessageKey> = {
  bottomLeft: "settings.notifications.toastPosition.bottomLeft",
  bottomRight: "settings.notifications.toastPosition.bottomRight",
  topLeft: "settings.notifications.toastPosition.topLeft",
  topRight: "settings.notifications.toastPosition.topRight",
};

const save = (preferences: NotificationPreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setNotifications", payload: { preferences } },
  });

export function NotificationsSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.notifications);
  const update = (patch: Partial<NotificationPreferences>) =>
    void save({ ...preferences, ...patch });

  return (
    <>
      <SettingRow label={t("settings.notifications.enabled")} hint={t("settings.notifications.enabledHint")}>
        <SettingsSwitch
          checked={preferences.enabled}
          onChange={(enabled) => update({ enabled })}
          label={t("settings.notifications.enabled")}
        />
      </SettingRow>
      <SettingRow label={t("settings.notifications.desktop")} hint={t("settings.notifications.desktopHint")}>
        <SettingsSwitch
          checked={preferences.desktop}
          disabled={!preferences.enabled}
          onChange={(desktop) => update({ desktop })}
          label={t("settings.notifications.desktop")}
        />
      </SettingRow>
      {/* What the switch above covers. Off, only the handful of kinds somebody
          is waiting on leave the client; on, the whole notification stream is
          mirrored, which is what the client used to do unconditionally. */}
      <SettingRow label={t("settings.notifications.desktopAllKinds")} hint={t("settings.notifications.desktopAllKindsHint")}>
        <SettingsSwitch
          checked={preferences.desktopAllKinds}
          disabled={!preferences.enabled || !preferences.desktop}
          onChange={(desktopAllKinds) => update({ desktopAllKinds })}
          label={t("settings.notifications.desktopAllKinds")}
        />
      </SettingRow>
      <SettingRow label={t("settings.notifications.sound")} hint={t("settings.notifications.soundHint")}>
        <SettingsSwitch
          checked={preferences.sound}
          disabled={!preferences.enabled}
          onChange={(sound) => update({ sound })}
          label={t("settings.notifications.sound")}
        />
      </SettingRow>
      <SettingRow label={t("settings.notifications.volume")} hint={t("settings.notifications.volumeHint")}>
        <label className="settings-volume">
          <input
            type="range"
            min={0}
            max={100}
            value={preferences.volume}
            disabled={!preferences.enabled || !preferences.sound}
            onChange={(event) => update({ volume: Number(event.target.value) })}
            aria-label={t("settings.notifications.volumeAria")}
          />
          <span>{preferences.volume}%</span>
        </label>
      </SettingRow>
      <SettingRow label={t("settings.notifications.toastPositionLabel")} hint={t("settings.notifications.toastPositionHint")}>
        <select
          className="settings-select"
          value={preferences.toastPosition}
          disabled={!preferences.enabled}
          onChange={(event) => update({ toastPosition: event.target.value as ToastPosition })}
          aria-label={t("settings.notifications.toastPositionLabel")}
        >
          {recordEntries(TOAST_POSITIONS).map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label={t("settings.notifications.whenFocused")} hint={t("settings.notifications.whenFocusedHint")}>
        <SettingsSwitch
          checked={preferences.notifyWhenFocused}
          disabled={!preferences.enabled || !preferences.desktop}
          onChange={(notifyWhenFocused) => update({ notifyWhenFocused })}
          label={t("settings.notifications.whenFocused")}
        />
      </SettingRow>
      <SettingRow label={t("settings.notifications.matchFound")} hint={t("settings.notifications.matchFoundHint")}>
        <SettingsSwitch checked={preferences.matchFound} disabled={!preferences.enabled} onChange={(matchFound) => update({ matchFound })} label={t("settings.notifications.matchFound")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.privateMessages")} hint={t("settings.notifications.privateMessagesHint")}>
        <SettingsSwitch checked={preferences.privateMessages} disabled={!preferences.enabled} onChange={(privateMessages) => update({ privateMessages })} label={t("settings.notifications.privateMessages")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.mentions")} hint={t("settings.notifications.mentionsHint")}>
        <SettingsSwitch checked={preferences.mentions} disabled={!preferences.enabled} onChange={(mentions) => update({ mentions })} label={t("settings.notifications.mentions")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.friendOnline")} hint={t("settings.notifications.friendOnlineHint")}>
        <SettingsSwitch checked={preferences.friendOnline} disabled={!preferences.enabled} onChange={(friendOnline) => update({ friendOnline })} label={t("settings.notifications.friendOnline")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.friendOffline")} hint={t("settings.notifications.friendOfflineHint")}>
        <SettingsSwitch checked={preferences.friendOffline} disabled={!preferences.enabled} onChange={(friendOffline) => update({ friendOffline })} label={t("settings.notifications.friendOffline")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.friendPlaying")} hint={t("settings.notifications.friendPlayingHint")}>
        <SettingsSwitch checked={preferences.friendPlaying} disabled={!preferences.enabled} onChange={(friendPlaying) => update({ friendPlaying })} label={t("settings.notifications.friendPlaying")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.newGames")} hint={t("settings.notifications.newGamesHint")}>
        <SettingsSwitch checked={preferences.newCustomGames} disabled={!preferences.enabled} onChange={(newCustomGames) => update({ newCustomGames })} label={t("settings.notifications.newGames")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.friendsGamesOnly")} hint={t("settings.notifications.friendsGamesOnlyHint")}>
        <SettingsSwitch checked={preferences.newCustomGamesFriendsOnly} disabled={!preferences.enabled || !preferences.newCustomGames} onChange={(newCustomGamesFriendsOnly) => update({ newCustomGamesFriendsOnly })} label={t("settings.notifications.friendsGamesOnly")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.gameFull")} hint={t("settings.notifications.gameFullHint")}>
        <SettingsSwitch checked={preferences.gameFull} disabled={!preferences.enabled} onChange={(gameFull) => update({ gameFull })} label={t("settings.notifications.gameFull")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.gameLaunched")} hint={t("settings.notifications.gameLaunchedHint")}>
        <SettingsSwitch checked={preferences.gameLaunched} disabled={!preferences.enabled} onChange={(gameLaunched) => update({ gameLaunched })} label={t("settings.notifications.gameLaunched")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.reviewReminder")} hint={t("settings.notifications.reviewReminderHint")}>
        <SettingsSwitch checked={preferences.reviewReminder} disabled={!preferences.enabled} onChange={(reviewReminder) => update({ reviewReminder })} label={t("settings.notifications.reviewReminder")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.partyInvites")} hint={t("settings.notifications.partyInvitesHint")}>
        <SettingsSwitch checked={preferences.partyInvites} disabled={!preferences.enabled} onChange={(partyInvites) => update({ partyInvites })} label={t("settings.notifications.partyInvites")} />
      </SettingRow>
    </>
  );
}
