import type { NotificationEvent, NotificationState } from "../../ipc/bindings";

export function reduceNotifications(
  state: NotificationState,
  event: NotificationEvent,
): NotificationState {
  switch (event.type) {
    case "added":
      return {
        items: [
          event.payload.notification,
          ...state.items.filter((item) => item.id !== event.payload.notification.id),
        ].slice(0, 50),
      };
    case "read":
      return {
        items: state.items.map((item) =>
          item.id === event.payload.id ? { ...item, read: true } : item,
        ),
      };
    case "dismissed":
      return { items: state.items.filter((item) => item.id !== event.payload.id) };
    case "cleared":
      return { items: [] };
  }
}
