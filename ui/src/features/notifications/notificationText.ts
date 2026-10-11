// What a notification says, in the reader's language (#458).
//
// The backend writes every notification in English and, for the ones it can,
// attaches the catalogue entry it was written from. The entry wins where the
// catalogue has it; a side it does not cover, such as the server's own reason
// for refusing something, is shown as the backend sent it.
//
// One exception to "as the backend sent it": a failure whose entry carries a
// `reason` parameter. That parameter is how the backend marks a body as a
// failure reason the client produced (an OS error, the HTTP client's English,
// a generator's complaint), and such a reason is worded through `plainError`,
// with the original kept for the tooltip. Only marked reasons, because an
// error notification's body is not always ours to reword: a kick, a ban or a
// rejected connection carries the server's own words, which `plainError`
// would mangle ("timed out" in a ban notice is not the network timing out).

import type { ClientNotification } from "../../ipc/bindings";
import { isMessageKey, t, type MessageKey, type MessageValues } from "../../i18n";
import { plainError } from "../../shared/plainError";

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

/** The failure reason the backend marked for wording, if this is one. */
function markedReason(item: ClientNotification): string | null {
  if (item.kind !== "error") return null;
  const reason = item.text?.params.reason;
  return reason !== undefined && reason.trim() !== "" ? reason : null;
}

/** Stands in for the reason to see where the entry puts it. */
const PROBE = "\u0000";

/**
 * The entry's body around the reason in a plain sentence.
 *
 * `plainError` answers with a whole sentence, full stop included. Where the
 * entry ends on the reason ("{folder} could not be downloaded: {reason}") the
 * stop is the one the line needs; where it carries on after it ("{reason}.
 * Open the upload again to retry.") the entry brings its own, and the
 * sentence's is dropped so the line does not read "..again.. Open". Which one
 * applies is asked of the entry itself, in the reader's language, because a
 * translation may put the reason somewhere else.
 */
function bodyAround(key: MessageKey, params: MessageValues, plain: string): string {
  const endsOnReason = t(key, { ...params, reason: PROBE }).endsWith(PROBE);
  return t(key, { ...params, reason: endsOnReason ? plain : plain.replace(/[.!?]$/, "") });
}

export function notificationTitle(item: ClientNotification): string {
  return translated(item, "title") ?? item.title;
}

export function notificationBody(item: ClientNotification): string {
  const reason = markedReason(item);
  if (reason !== null && item.text) {
    const plain = plainError(reason);
    const key = `${item.text.key}.body`;
    return isMessageKey(key) ? bodyAround(key, values(item.text.params), plain) : plain;
  }
  return translated(item, "body") ?? item.body;
}

/**
 * The reason as it was sent, for the body's tooltip, when the body says it
 * more plainly. Null when what is shown is all there is.
 */
export function notificationBodyDetail(item: ClientNotification): string | null {
  const reason = markedReason(item);
  return reason !== null && reason !== notificationBody(item) ? reason : null;
}
