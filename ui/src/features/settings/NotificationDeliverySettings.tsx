import { useEffect, useState } from "react";
import type { DesktopNotificationStyle, NotificationKind, NotificationPreferences, NotificationPreferencesPatch, ToastPosition } from "../../ipc/bindings";
import { native } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";
import { Icon } from "../../design-system/Icon";
import { SettingRow, SettingsSwitch, useSettingsIndexEntry } from "./SettingControls";
import { NumberInput } from "../../design-system/NumberInput";
import { deliveryFor } from "../notifications/notificationDelivery";

type Update = (patch: NotificationPreferencesPatch) => void;

const EVENTS: [NotificationKind, MessageKey][] = [
  ["matchFound", "settings.notifications.matchFound"],
  ["privateMessage", "settings.notifications.privateMessages"],
  ["mention", "settings.notifications.mentions"],
  ["friendOnline", "settings.notifications.friendOnline"],
  ["friendOffline", "settings.notifications.friendOffline"],
  ["friendPlaying", "settings.notifications.friendPlaying"],
  ["friendJoinedGame", "settings.notifications.friendJoinedGame"],
  ["newCustomGame", "settings.notifications.newGames"],
  ["gameFull", "settings.notifications.gameFull"],
  ["gameLaunched", "settings.notifications.gameLaunched"],
  ["reviewReminder", "settings.notifications.reviewReminder"],
  ["partyInvite", "settings.notifications.partyInvites"],
  ["mapGenerated", "settings.notifications.mapGenerated"],
];
const CHANNELS = ["sound", "popup", "desktop"] as const;
const POSITIONS: ToastPosition[] = ["bottomRight", "bottomLeft", "topRight", "topLeft"];

const usePreferences = () => useAppStore((state) => state.state.settings.notifications);
const desktopOff = (preferences: NotificationPreferences) => !preferences.enabled || !preferences.desktop;

/**
 * Windows names a display `\\.\DISPLAY2`; the settings show "Display 2". A
 * name in any other shape (Linux, or a future runtime) is shown as it is.
 */
function displayName(name: string, numbered: (number: string) => string): string {
  const number = /DISPLAY(\d+)$/i.exec(name)?.[1];
  return number ? numbered(number) : name;
}

/** Popup or system notification, its test button, and where the popup goes. */
export function DesktopNotificationSettings({ update }: { update: Update }) {
  const { t } = useTranslation();
  const preferences = usePreferences();
  const [displays, setDisplays] = useState<{ name: string; primary: boolean }[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { void native.notificationDisplays().then(setDisplays, () => setDisplays([])); }, []);
  const style = preferences.desktopStyle ?? "popup";
  const numbered = (number: string) => t("settings.notifications.displayNumber", { number });
  const preview = async () => {
    setError("");
    try {
      if (style === "system") {
        if (!await native.ensureNotificationPermission()) throw new Error(t("settings.notifications.permissionDenied"));
        native.sendNotification(t("notifications.msg.matchFound.title"), t("settings.notifications.previewBody"));
      } else {
        await native.showNotificationPopup([{
          id: "preview", title: t("notifications.msg.matchFound.title"), body: t("settings.notifications.previewBody"), actionLabel: null, tone: "",
        }], t("notifications.popup.dismiss"), true);
      }
    } catch (reason) { setError(String(reason)); }
  };
  return <>
    <SettingRow label={t("settings.notifications.desktopStyle")} hint={t("settings.notifications.desktopStyleHint")}>
      <select className="settings-select" value={style} disabled={desktopOff(preferences)}
        aria-label={t("settings.notifications.desktopStyle")} onChange={(e) => update({ desktopStyle: e.target.value as DesktopNotificationStyle })}>
        <option value="popup">{t("settings.notifications.desktopStyle.popup")}</option>
        <option value="system">{t("settings.notifications.desktopStyle.system")}</option>
      </select>
      <button className="btn-ghost" type="button" disabled={desktopOff(preferences)} onClick={() => void preview()}>{t("settings.notifications.preview")}</button>
    </SettingRow>
    {error && <p role="alert" className="settings-inline-error">{error}</p>}
    {style === "popup" && <>
      <SettingRow label={t("settings.notifications.desktopMonitor")}>
        <select className="settings-select" aria-label={t("settings.notifications.desktopMonitor")}
          disabled={desktopOff(preferences)} value={preferences.desktopMonitor ?? ""}
          onChange={(e) => update({ desktopMonitor: e.target.value || null })}>
          <option value="">{t("settings.notifications.primaryMonitor")}</option>
          {preferences.desktopMonitor && !displays.some((d) => d.name === preferences.desktopMonitor)
            && <option value={preferences.desktopMonitor}>{displayName(preferences.desktopMonitor, numbered)}</option>}
          {displays.map((display) => <option key={display.name} value={display.name}>
            {displayName(display.name, numbered)}{display.primary ? ` (${t("settings.notifications.primaryMonitor")})` : ""}
          </option>)}
        </select>
      </SettingRow>
      <SettingRow label={t("settings.notifications.desktopPosition")}>
        <select className="settings-select" aria-label={t("settings.notifications.desktopPosition")}
          disabled={desktopOff(preferences)} value={preferences.desktopPosition ?? "bottomRight"}
          onChange={(e) => update({ desktopPosition: e.target.value as ToastPosition })}>
          {POSITIONS.map((position) => <option key={position} value={position}>{t(`settings.notifications.toastPosition.${position}`)}</option>)}
        </select>
      </SettingRow>
    </>}
  </>;
}

/** How long a card stays, in the client and on the desktop alike. */
export function ToastDurationSetting({ update }: { update: Update }) {
  const { t } = useTranslation();
  const preferences = usePreferences();
  return <SettingRow label={t("settings.notifications.duration")} hint={t("settings.notifications.durationHint")}>
    <NumberInput className="number-input" value={preferences.toastDurationSeconds ?? 5} min={2} max={60} disabled={!preferences.enabled}
      aria-label={t("settings.notifications.duration")} onChange={(seconds) => update({ toastDurationSeconds: Math.min(60, Math.max(2, Math.round(seconds))) })} />
  </SettingRow>;
}

/** Narrows the mention alert to `@name`; sits under the mention row it narrows. */
export function MentionAtSetting({ update }: { update: Update }) {
  const { t } = useTranslation();
  const preferences = usePreferences();
  return <SettingRow label={t("settings.notifications.requireAt")} hint={t("settings.notifications.requireAtHint")}>
    <SettingsSwitch checked={preferences.mentionsRequireAt ?? false} disabled={!preferences.enabled || !preferences.mentions}
      label={t("settings.notifications.requireAt")} onChange={(mentionsRequireAt) => update({ mentionsRequireAt })} />
  </SettingRow>;
}

/**
 * Sound, in-client card and desktop notification for each event, as one
 * table folded away by default: most people never change these, and thirteen
 * rows of three labelled switches would push everything below them off the
 * page.
 */
export function EventDeliverySettings({ update }: { update: Update }) {
  const { t } = useTranslation();
  const preferences = usePreferences();
  useSettingsIndexEntry(t("settings.notifications.delivery"), t("settings.notifications.deliveryHint"));
  return <details className="notification-delivery">
    <summary>
      <span className="setting-copy">
        <span className="setting-label">{t("settings.notifications.delivery")}</span>
        <span className="muted">{t("settings.notifications.deliveryHint")}</span>
      </span>
      <Icon name="chevronDown" size={16} />
    </summary>
    <table className="notification-delivery-table">
      <thead>
        <tr>
          <th scope="col">{t("settings.notifications.delivery.event")}</th>
          {CHANNELS.map((channel) => <th scope="col" key={channel}>{t(`settings.notifications.delivery.${channel}`)}</th>)}
          <th scope="col" aria-label={t("settings.notifications.inherit")} />
        </tr>
      </thead>
      <tbody>
        {EVENTS.map(([kind, label]) => {
          const override = preferences.delivery?.[kind];
          // What this event does with every global switch on: the table edits
          // the event, and the switches above still apply on top of it.
          const effective = deliveryFor(kind, { ...preferences, enabled: true, sound: true, popup: true, desktop: true });
          return <tr key={kind}>
            <th scope="row">{t(label)}</th>
            {CHANNELS.map((channel) => <td key={channel}>
              <SettingsSwitch disabled={!preferences.enabled} checked={effective[channel]}
                label={`${t(label)}: ${t(`settings.notifications.delivery.${channel}`)}`}
                onChange={(checked) => update({ delivery: { events: { [kind]: { [channel]: checked } } } })} />
            </td>)}
            <td>
              {override && <button type="button" className="btn-ghost" onClick={() => update({ delivery: { events: { [kind]: null } } })}>
                {t("settings.notifications.inherit")}
              </button>}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
  </details>;
}
