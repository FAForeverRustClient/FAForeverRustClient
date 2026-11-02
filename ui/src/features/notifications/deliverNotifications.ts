import type { AppState, ClientNotification } from "../../ipc/bindings";
import { native, type NotificationPopupCard } from "../../ipc/native";
import { t } from "../../i18n";
import { stripHtmlTags } from "../chat/messages/chatFormat";
import { deliveryFor } from "./notificationDelivery";
import { notificationArtwork } from "./notificationArtwork";
import { actionLabel, notificationTone } from "./notificationPresentation";
import { notificationBody, notificationTitle } from "./notificationText";
import { playNotificationSound, soundForKind } from "./notificationSound";
import { happensInView, RepeatCooldown } from "./notificationGate";

export type DeliveryOutcome = "disabled" | "eventDisabled" | "inView" | "cooldown" | "channelsOff" | "gameFocused" | "soundMuted"
  | "sound" | "client" | "desktop" | "system" | "permissionDenied" | "desktopFailed" | "focusSuppressed";
export type DeliveryResult = { id: string; outcome: DeliveryOutcome; detail?: string };
export type DeliveryOptions = {
  state: () => AppState;
  showInside: (items: ClientNotification[]) => void;
  current?: (item: ClientNotification) => boolean;
  artwork?: (item: ClientNotification) => string | null;
  report?: (result: DeliveryResult) => void;
  test?: boolean;
};

export function popupCard(item: ClientNotification, artwork: string | null): NotificationPopupCard {
  return { id: item.id, title: notificationTitle(item), body: stripHtmlTags(notificationBody(item)),
    actionLabel: actionLabel(item.action), tone: notificationTone(item).trim(), imageUrl: artwork };
}

/** Admission is shared by live notifications and synthetic local delivery tests. */
export function admitNotifications(items: ClientNotification[], state: AppState, cooldown: RepeatCooldown,
  read: (id: string) => void, report?: DeliveryOptions["report"], focused = document.hasFocus()) {
  return items.filter((item) => {
    const reject = (outcome: DeliveryOutcome) => { report?.({ id: item.id, outcome }); return false; };
    if (!state.settings.notifications.enabled) return reject("disabled");
    if (happensInView(item, state.nav.activeTab, state.chat.activeChannel, focused)) {
      read(item.id); return reject("inView");
    }
    if (!cooldown.admit(item.kind, Date.now(), state.settings.notifications.repeatCooldownSeconds ?? 0)) return reject("cooldown");
    return Object.values(deliveryFor(item.kind, state.settings.notifications)).some(Boolean) || reject("channelsOff");
  });
}

/** Calls the real native bridge, including its display acknowledgement and OS fallback. */
export async function deliverNotifications(items: ClientNotification[], options: DeliveryOptions) {
  if (!items.length) return;
  const { state, report } = options;
  const current = (item: ClientNotification) => state().settings.notifications.enabled
    && (options.current?.(item) ?? state().notifications.items.some((n) => n.id === item.id && !n.read));
  const record = (candidates: ClientNotification[], outcome: DeliveryOutcome, detail?: string) => candidates.forEach((item) => report?.({ id: item.id, outcome, detail }));
  const focused = await native.isWindowFocused().catch(() => document.hasFocus());
  const gameFocused = items.some((item) => item.kind === "gameFull") && await native.gameNotificationAttention().catch(() => false);
  if (!focused && !gameFocused) void native.requestAttention().catch(() => undefined);
  const visible = items.filter((item) => {
    if (item.kind === "gameFull" && gameFocused) { record([item], "gameFocused"); return false; }
    if (!current(item)) { record([item], "disabled"); return false; }
    return true;
  });
  const latest = state().settings.notifications;
  visible.forEach((item) => {
    if (deliveryFor(item.kind, latest).sound) {
      const sound = soundForKind(item.kind, latest.sounds);
      if (sound !== "silent" && latest.volume > 0) {
        playNotificationSound(sound, latest.volume); record([item], "sound");
      } else record([item], "soundMuted");
    }
  });
  const desktop = visible.filter((item) => {
    if (!deliveryFor(item.kind, latest).desktop) return false;
    if (focused && !latest.notifyWhenFocused) { record([item], "focusSuppressed"); return false; }
    return true;
  });
  const popupStyle = (latest.desktopStyle ?? "popup") === "popup";
  const inside = (candidates: ClientNotification[]) => {
    const accepted = candidates.filter((item) => current(item) && deliveryFor(item.kind, state().settings.notifications).popup);
    if (accepted.length) { options.showInside(accepted); record(accepted, "client"); }
  };
  inside(visible.filter((item) => !(popupStyle && desktop.includes(item))));
  let delivered = false;
  if (desktop.length && popupStyle) {
    try {
      await native.showNotificationPopup(desktop.map((item) => popupCard(item,
        options.artwork ? options.artwork(item) : notificationArtwork(item, state()))), t("notifications.popup.dismiss"), options.test ?? false);
      delivered = true;
      record(desktop, "desktop");
    } catch (reason) { record(desktop, "desktopFailed", String(reason)); }
  }
  if (desktop.length && !delivered) {
    const focusedNow = await native.isWindowFocused().catch(() => true);
    const fallback = desktop.filter((item) => current(item) && deliveryFor(item.kind, state().settings.notifications).desktop
      && (!focusedNow || state().settings.notifications.notifyWhenFocused));
    if (fallback.length) {
      if (await native.ensureNotificationPermission().catch(() => false)) {
        const stillCurrent = fallback.filter((item) => current(item) && deliveryFor(item.kind, state().settings.notifications).desktop);
        stillCurrent.forEach((item) => native.sendNotification(notificationTitle(item), stripHtmlTags(notificationBody(item))));
        record(stillCurrent, "system");
      } else record(fallback, "permissionDenied");
    }
  }
  if (popupStyle && !delivered) inside(desktop);
}
