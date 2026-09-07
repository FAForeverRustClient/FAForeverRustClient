import { describe, expect, it } from "vitest";
import type { NotificationKind } from "../../ipc/bindings";
import { raisesOsNotification } from "./osNotifications";

// The twin in `faf-domain/src/state/notifications.rs` carries the same list and
// the same test. Two lists that can drift is the risk of a hand-written twin;
// spelling both out is what makes the drift visible in review.
describe("which notifications leave the client", () => {
  it("lets through the four kinds somebody is waiting on", () => {
    for (const kind of ["matchFound", "partyInvite", "gameLaunched", "mapGenerated"] as const) {
      expect(raisesOsNotification(kind)).toBe(true);
    }
  });

  it("keeps the ones that read as urgent and are not", () => {
    // Every one of these is worth reading and none is worth taking the screen
    // away from somebody mid-game: they are all still there on the way back.
    const keeps: NotificationKind[] = [
      "error",
      "serverWarning",
      "serverNotice",
      "gameCacheAlert",
      "clientUpdate",
      "privateMessage",
      "mention",
      "friendOnline",
      "friendOffline",
      "friendPlaying",
      "newCustomGame",
      "gameFull",
      "reviewReminder",
      "replayAvailable",
      "reportSubmitted",
    ];
    for (const kind of keeps) {
      expect(raisesOsNotification(kind), kind).toBe(false);
    }
  });
});
