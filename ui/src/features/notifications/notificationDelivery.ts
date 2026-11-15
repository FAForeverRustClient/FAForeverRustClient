import type { NotificationKind, NotificationPreferences } from "../../ipc/bindings";
import { raisesOsNotification } from "./osNotifications";

/** Per-event limits never override a disabled global switch. */
export function deliveryFor(kind: NotificationKind, preferences: NotificationPreferences) {
  const override = preferences.delivery?.[kind];
  const enabled = preferences.enabled && (kind !== "draftTurn" || preferences.draftTurn);
  return {
    sound: enabled && preferences.sound && (override?.sound ?? true),
    popup: enabled && preferences.popup && (override?.popup ?? true),
    desktop: enabled && preferences.desktop
      && (override?.desktop ?? (preferences.desktopAllKinds || raisesOsNotification(kind))),
  };
}
