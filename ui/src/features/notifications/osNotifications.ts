// Which notifications are allowed to leave the client.
//
// Twin of `NotificationKind::raises_os_notification` in
// `faf-domain/src/state/notifications.rs`, which carries the reasoning. The
// short version: an OS notification interrupts, the notification centre does
// not, so the list is not "what is important" but "what is somebody waiting on
// that expires". Mirroring the whole stream, which is what the client did
// before, put a toast over whatever the user was doing every time a friend came
// online.

import type { NotificationKind } from "../../ipc/bindings";

/** The kinds a user is not being asked to come back for later. */
const EXPIRING: readonly NotificationKind[] = [
  "matchFound",
  "partyInvite",
  "gameLaunched",
  "mapGenerated",
];

export function raisesOsNotification(kind: NotificationKind): boolean {
  return EXPIRING.includes(kind);
}
