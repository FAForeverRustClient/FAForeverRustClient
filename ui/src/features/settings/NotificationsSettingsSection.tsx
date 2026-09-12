import type {
  NotificationPreferences,
  NotificationSound,
  NotificationSoundChoices,
  ToastPosition,
} from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { recordEntries } from "../../shared/records";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../design-system/Icon";
import { native } from "../../ipc/native";
import type { AudibleSound } from "../notifications/notificationSound";
import {
  customSoundName,
  forgetCustomSounds,
  playNotificationSound,
  soundFromOptionValue,
  soundOptionValue,
} from "../notifications/notificationSound";
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

/* Quietest first, so the list itself says what the choice is about. */
const SOUNDS: Record<AudibleSound | "silent", MessageKey> = {
  silent: "settings.notifications.sound.silent",
  soft: "settings.notifications.sound.soft",
  chime: "settings.notifications.sound.chime",
  ping: "settings.notifications.sound.ping",
  alert: "settings.notifications.sound.alert",
};

/**
 * The option value that opens the file picker.
 *
 * A row in the dropdown rather than a button beside it, because "the sounds I
 * can pick" and "add one" belong in the same list: every row here answers the
 * same question, and a player looking for their own file looks where the
 * shipped ones are. It is never a stored choice -- picking it opens a dialog
 * and the row reverts to whatever it was -- so it has a value no file name can
 * collide with, `custom:` being the prefix a stored one uses.
 */
const ADD_VALUE = "add-a-sound";

/**
 * The tone one kind of notification plays, next to the switch that turns that
 * notification on. Picking one plays it: a list of five words is not something
 * anybody can choose from without hearing them.
 */
function SoundChoice({
  value,
  disabled,
  what,
  custom,
  onChange,
  onAdd,
}: {
  value: NotificationSound;
  disabled: boolean;
  what: string;
  /** The stored sounds, shared by every row: one list, one read from disk. */
  custom: readonly string[];
  onChange: (sound: NotificationSound) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const volume = useAppStore((state) => state.state.settings.notifications.volume);
  const chosen = customSoundName(value);
  // A row set to a file that has since been removed still has to show what it
  // is set to, or the dropdown would silently read as the first entry and the
  // next save would write that instead.
  const missing = chosen !== null && !custom.includes(chosen);
  return (
    <select
      className="settings-select settings-sound-select"
      value={soundOptionValue(value)}
      disabled={disabled}
      aria-label={t("settings.notifications.soundFor", { what })}
      onChange={(event) => {
        if (event.target.value === ADD_VALUE) {
          onAdd();
          return;
        }
        const sound = soundFromOptionValue(event.target.value);
        onChange(sound);
        playNotificationSound(sound, volume);
      }}
    >
      {recordEntries(SOUNDS).map(([sound, label]) => (
        <option key={sound} value={sound}>
          {t(label)}
        </option>
      ))}
      {missing && (
        <option value={soundOptionValue(value)}>
          {t("settings.notifications.sound.missing", { name: chosen })}
        </option>
      )}
      {custom.map((name) => (
        <option key={name} value={`custom:${name}`}>
          {name}
        </option>
      ))}
      <option value={ADD_VALUE}>{t("settings.notifications.sound.add")}</option>
    </select>
  );
}

export function NotificationsSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.notifications);
  const volume = preferences.volume;
  const update = (patch: Partial<NotificationPreferences>) =>
    void save({ ...preferences, ...patch });
  const setSound = (patch: Partial<NotificationSoundChoices>) =>
    update({ sounds: { ...preferences.sounds, ...patch } });
  // A tone is only reachable when notifications and sound are both on.
  const mute = !preferences.enabled || !preferences.sound;

  // The sounds on disk, read once when the page opens and after an import
  // rather than per row: twelve dropdowns showing the same list is one read.
  const [customSounds, setCustomSounds] = useState<string[]>([]);
  const [soundError, setSoundError] = useState("");
  const reloadSounds = useCallback(
    () => void native.listNotificationSounds().then(setCustomSounds, () => setCustomSounds([])),
    [],
  );
  useEffect(reloadSounds, [reloadSounds]);

  /**
   * Pick a file, keep a copy, and select it in the row that asked.
   *
   * The import is what puts the file where the settings can name it, so the
   * choice is only written once the copy has succeeded: a row pointing at a
   * file that was never stored would be silence with no explanation.
   */
  const addSound = useCallback(() => {
    ipc.run((async () => {
      const picked = await native.selectFile({
        title: t("settings.notifications.sound.pickTitle"),
        filters: [{
          name: t("settings.notifications.sound.pickFilter"),
          extensions: ["wav", "mp3", "ogg", "flac", "m4a"],
        }],
      });
      if (picked === null) return;
      try {
        const stored = await native.importNotificationSound(picked);
        forgetCustomSounds();
        reloadSounds();
        setSoundError("");
        playNotificationSound({ custom: stored }, volume);
      } catch (error) {
        setSoundError(String(error));
      }
    })());
  }, [reloadSounds, t, volume]);

  /**
   * Delete one added sound, and put every row that used it back on a tone.
   *
   * The settings are rewritten before the file goes, so a row can never be
   * left naming a file that is not there: that state is silence with a
   * "(missing)" label and no way back to it from the dropdown.
   */
  const removeSound = useCallback((name: string) => {
    const sounds = { ...preferences.sounds };
    for (const [kind, sound] of recordEntries(sounds)) {
      if (customSoundName(sound) === name) sounds[kind] = "chime";
    }
    void save({ ...preferences, sounds });
    ipc.run(native.removeNotificationSound(name).then(() => {
      forgetCustomSounds();
      reloadSounds();
    }));
  }, [preferences, reloadSounds]);

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
      {/* Why a picked file was not kept: the wrong format, or too large. The
          dropdown it was picked from is twelve rows down the page, so the
          reason goes here, beside the switch that owns all of them, rather
          than in the row that happened to open the dialog. */}
      {soundError !== "" && (
        <p className="settings-inline-error" role="alert">
          {t("settings.notifications.sound.importFailed", { reason: soundError })}
        </p>
      )}
      <SettingRow label={t("settings.notifications.volume")} hint={t("settings.notifications.volumeHint")}>
        <label className="settings-volume">
          <input
            type="range"
            min={0}
            max={100}
            value={preferences.volume}
            disabled={!preferences.enabled || !preferences.sound}
            onChange={(event) => update({ volume: Number(event.target.value) })}
            // A sample when the slider is let go, not on every step of the
            // drag: a percentage is not something anybody can set by eye, and
            // a tone per pixel of travel would be unusable.
            onPointerUp={(event) => playNotificationSound("chime", Number(event.currentTarget.value))}
            onKeyUp={(event) => playNotificationSound("chime", Number(event.currentTarget.value))}
            aria-label={t("settings.notifications.volumeAria")}
          />
          <span>{preferences.volume}%</span>
        </label>
      </SettingRow>
      {/* The added files, once there are any. Adding one is a row in every
          dropdown, but removing one cannot be: a dropdown sets a value and
          this deletes a file twelve of them may be pointing at. So it lives
          here, once, and says which rows it would silence. */}
      {customSounds.length > 0 && (
        <SettingRow
          label={t("settings.notifications.sound.yours")}
          hint={t("settings.notifications.sound.yoursHint")}
        >
          <ul className="settings-sound-list">
            {customSounds.map((name) => (
              <li key={name} className="settings-sound-list-item">
                <button
                  type="button"
                  className="btn-ghost settings-sound-play"
                  onClick={() => playNotificationSound({ custom: name }, volume)}
                  title={t("settings.notifications.sound.preview", { name })}
                >
                  {name}
                </button>
                <button
                  type="button"
                  className="btn-ghost settings-sound-remove"
                  onClick={() => removeSound(name)}
                  title={t("settings.notifications.sound.remove", { name })}
                  aria-label={t("settings.notifications.sound.remove", { name })}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
        </SettingRow>
      )}
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
        <SoundChoice value={preferences.sounds.matchFound} disabled={mute || !preferences.matchFound} what={t("settings.notifications.matchFound")} onChange={(matchFound) => setSound({ matchFound })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.matchFound} disabled={!preferences.enabled} onChange={(matchFound) => update({ matchFound })} label={t("settings.notifications.matchFound")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.privateMessages")} hint={t("settings.notifications.privateMessagesHint")}>
        <SoundChoice value={preferences.sounds.privateMessage} disabled={mute || !preferences.privateMessages} what={t("settings.notifications.privateMessages")} onChange={(privateMessage) => setSound({ privateMessage })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.privateMessages} disabled={!preferences.enabled} onChange={(privateMessages) => update({ privateMessages })} label={t("settings.notifications.privateMessages")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.mentions")} hint={t("settings.notifications.mentionsHint")}>
        <SoundChoice value={preferences.sounds.mention} disabled={mute || !preferences.mentions} what={t("settings.notifications.mentions")} onChange={(mention) => setSound({ mention })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.mentions} disabled={!preferences.enabled} onChange={(mentions) => update({ mentions })} label={t("settings.notifications.mentions")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.friendOnline")} hint={t("settings.notifications.friendOnlineHint")}>
        <SoundChoice value={preferences.sounds.friendOnline} disabled={mute || !preferences.friendOnline} what={t("settings.notifications.friendOnline")} onChange={(friendOnline) => setSound({ friendOnline })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.friendOnline} disabled={!preferences.enabled} onChange={(friendOnline) => update({ friendOnline })} label={t("settings.notifications.friendOnline")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.friendOffline")} hint={t("settings.notifications.friendOfflineHint")}>
        <SoundChoice value={preferences.sounds.friendOffline} disabled={mute || !preferences.friendOffline} what={t("settings.notifications.friendOffline")} onChange={(friendOffline) => setSound({ friendOffline })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.friendOffline} disabled={!preferences.enabled} onChange={(friendOffline) => update({ friendOffline })} label={t("settings.notifications.friendOffline")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.friendPlaying")} hint={t("settings.notifications.friendPlayingHint")}>
        <SoundChoice value={preferences.sounds.friendPlaying} disabled={mute || !preferences.friendPlaying} what={t("settings.notifications.friendPlaying")} onChange={(friendPlaying) => setSound({ friendPlaying })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.friendPlaying} disabled={!preferences.enabled} onChange={(friendPlaying) => update({ friendPlaying })} label={t("settings.notifications.friendPlaying")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.newGames")} hint={t("settings.notifications.newGamesHint")}>
        <SoundChoice value={preferences.sounds.newCustomGame} disabled={mute || !preferences.newCustomGames} what={t("settings.notifications.newGames")} onChange={(newCustomGame) => setSound({ newCustomGame })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.newCustomGames} disabled={!preferences.enabled} onChange={(newCustomGames) => update({ newCustomGames })} label={t("settings.notifications.newGames")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.friendsGamesOnly")} hint={t("settings.notifications.friendsGamesOnlyHint")}>
        <SettingsSwitch checked={preferences.newCustomGamesFriendsOnly} disabled={!preferences.enabled || !preferences.newCustomGames} onChange={(newCustomGamesFriendsOnly) => update({ newCustomGamesFriendsOnly })} label={t("settings.notifications.friendsGamesOnly")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.gameFull")} hint={t("settings.notifications.gameFullHint")}>
        <SoundChoice value={preferences.sounds.gameFull} disabled={mute || !preferences.gameFull} what={t("settings.notifications.gameFull")} onChange={(gameFull) => setSound({ gameFull })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.gameFull} disabled={!preferences.enabled} onChange={(gameFull) => update({ gameFull })} label={t("settings.notifications.gameFull")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.gameLaunched")} hint={t("settings.notifications.gameLaunchedHint")}>
        <SoundChoice value={preferences.sounds.gameLaunched} disabled={mute || !preferences.gameLaunched} what={t("settings.notifications.gameLaunched")} onChange={(gameLaunched) => setSound({ gameLaunched })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.gameLaunched} disabled={!preferences.enabled} onChange={(gameLaunched) => update({ gameLaunched })} label={t("settings.notifications.gameLaunched")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.reviewReminder")} hint={t("settings.notifications.reviewReminderHint")}>
        <SoundChoice value={preferences.sounds.reviewReminder} disabled={mute || !preferences.reviewReminder} what={t("settings.notifications.reviewReminder")} onChange={(reviewReminder) => setSound({ reviewReminder })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.reviewReminder} disabled={!preferences.enabled} onChange={(reviewReminder) => update({ reviewReminder })} label={t("settings.notifications.reviewReminder")} />
      </SettingRow>
      <SettingRow label={t("settings.notifications.partyInvites")} hint={t("settings.notifications.partyInvitesHint")}>
        <SoundChoice value={preferences.sounds.partyInvite} disabled={mute || !preferences.partyInvites} what={t("settings.notifications.partyInvites")} onChange={(partyInvite) => setSound({ partyInvite })} custom={customSounds} onAdd={addSound} />
        <SettingsSwitch checked={preferences.partyInvites} disabled={!preferences.enabled} onChange={(partyInvites) => update({ partyInvites })} label={t("settings.notifications.partyInvites")} />
      </SettingRow>
      {/* No sound picker, deliberately: a stream is the one kind here that is
          not about this player's game, and a tone for it would be the client
          making a noise on FAF's behalf. */}
      <SettingRow label={t("settings.notifications.streamLive")} hint={t("settings.notifications.streamLiveHint")}>
        <SettingsSwitch checked={preferences.streamLive} disabled={!preferences.enabled} onChange={(streamLive) => update({ streamLive })} label={t("settings.notifications.streamLive")} />
      </SettingRow>
      {/* The kinds with no switch of their own: server notices, errors, a
          finished map, a new client version. One row rather than nine, because
          nobody is going to want a different tone for each of them. */}
      <SettingRow label={t("settings.notifications.otherSounds")} hint={t("settings.notifications.otherSoundsHint")}>
        <SoundChoice value={preferences.sounds.other} disabled={mute} what={t("settings.notifications.otherSounds")} onChange={(other) => setSound({ other })} custom={customSounds} onAdd={addSound} />
      </SettingRow>
    </>
  );
}
