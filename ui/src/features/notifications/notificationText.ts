// What a notification says, in the reader's language (#458).
//
// The backend writes every notification in English and, for the ones it can,
// attaches the catalogue entry it was written from. The entry wins where the
// catalogue has it; a side it does not cover, such as the server's own reason
// for refusing something, is shown as the backend sent it.

import type { ClientNotification } from "../../ipc/bindings";
import { isMessageKey, t, type MessageValues } from "../../i18n";

function values(params: Record<string, string>): MessageValues {
  // Plural forms select on a number, and every value is a string on the wire.
  const out: MessageValues = {};
  for (const [name, value] of Object.entries(params)) {
    out[name] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

function translated(item: ClientNotification, side: "title" | "body"): string | null {
  if (!item.text) return null;
  const key = `${item.text.key}.${side}`;
  return isMessageKey(key) ? t(key, values(item.text.params)) : null;
}

export function notificationTitle(item: ClientNotification): string {
  return translated(item, "title") ?? item.title;
}

export function notificationBody(item: ClientNotification): string {
  return translated(item, "body") ?? item.body;
}
