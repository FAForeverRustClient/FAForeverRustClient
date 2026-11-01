import type { NotificationKind, NotificationPreferences } from "../../ipc/bindings";
import { raisesOsNotification } from "./osNotifications";

/** Per-event limits never override a disabled global switch. */
export function deliveryFor(kind: NotificationKind, preferences: NotificationPreferences) {
  const override = preferences.delivery?.[kind];
  return {
    sound: preferences.enabled && preferences.sound && (override?.sound ?? true),
    popup: preferences.enabled && preferences.popup && (override?.popup ?? true),
    desktop: preferences.enabled && preferences.desktop
      && (override?.desktop ?? (preferences.desktopAllKinds || raisesOsNotification(kind))),
  };
}
