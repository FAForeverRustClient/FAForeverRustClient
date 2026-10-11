// Which freshly raised notifications are announced (toast, sound, desktop)
// and which only land in the history. Pure, so it can be tested without a
// store or a window.

import type { ClientNotification, Tab } from "../../ipc/bindings";

/**
 * Is this a message in the very conversation the player is looking at (#381)?
 *
 * A toast and a chime for a line that has just appeared in front of them is
 * the client reporting the screen back to its reader. Only while the window
 * has focus: a chat left open in a window behind the game is not being read.
 */
export function happensInView(
  item: ClientNotification,
  activeTab: Tab,
  activeChannel: string,
  windowFocused: boolean,
): boolean {
  if (!windowFocused || activeTab !== "chat") return false;
  if (item.kind !== "privateMessage" && item.kind !== "mention") return false;
  const action = item.action;
  if (!action || action.type !== "openChat") return false;
  return action.payload.channel.toLowerCase() === activeChannel.toLowerCase();
}

/**
 * Remembers when each kind was last announced, and says whether another of
 * the same kind comes too soon after it (#382).
 *
 * Per kind rather than per notification: what was asked for is "I can only be
 * pinged every few seconds", however many people do the pinging. A
 * notification that comes too soon is not lost, it is in the history like any
 * other; it only does not toast, sound or reach the desktop again.
 */
export class RepeatCooldown {
  private last = new Map<string, number>();

  /** `true` when the item may be announced, and records that it was. */
  admit(kind: string, now: number, cooldownSeconds: number): boolean {
    const previous = this.last.get(kind);
    if (previous !== undefined && now - previous < cooldownSeconds * 1000) return false;
    this.last.set(kind, now);
    return true;
  }
}
