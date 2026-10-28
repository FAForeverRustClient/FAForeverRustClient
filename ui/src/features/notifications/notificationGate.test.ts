import { describe, expect, it } from "vitest";
import type { ClientNotification } from "../../ipc/bindings";
import { RepeatCooldown, expiredNotifications, happensInView, nextExpiry } from "./notificationGate";

function message(kind: ClientNotification["kind"], channel: string): ClientNotification {
  return {
    id: "1",
    kind,
    title: "Message from Someone",
    body: "hi",
    createdAt: "2026-10-01T12:00:00Z",
    read: false,
    action: { type: "openChat", payload: { channel } },
    text: null,
  };
}

describe("a message in the conversation on screen (#381)", () => {
  it("is not announced while that conversation is open and the window has focus", () => {
    expect(happensInView(message("privateMessage", "Someone"), "chat", "someone", true)).toBe(true);
    expect(happensInView(message("mention", "#aeolus"), "chat", "#aeolus", true)).toBe(true);
  });

  it("is announced from another conversation, another tab or a window in the background", () => {
    expect(happensInView(message("mention", "#aeolus"), "chat", "#german", true)).toBe(false);
    expect(happensInView(message("mention", "#aeolus"), "play", "#aeolus", true)).toBe(false);
    expect(happensInView(message("mention", "#aeolus"), "chat", "#aeolus", false)).toBe(false);
  });
});

describe("the repeat cooldown (#382)", () => {
  it("lets one of a kind through per cooldown and keeps kinds apart", () => {
    const gate = new RepeatCooldown();
    expect(gate.admit("mention", 0, 2)).toBe(true);
    expect(gate.admit("mention", 1500, 2)).toBe(false);
    expect(gate.admit("partyInvite", 1500, 2)).toBe(true);
    expect(gate.admit("mention", 2000, 2)).toBe(true);
  });

  it("lets everything through at zero", () => {
    const gate = new RepeatCooldown();
    expect(gate.admit("mention", 0, 0)).toBe(true);
    expect(gate.admit("mention", 0, 0)).toBe(true);
  });
});

describe("a notification leaving the history by itself (#644)", () => {
  const at = (id: string, createdAt: string): ClientNotification => ({ ...message("friendPlaying", ""), id, createdAt });
  const items = [at("old", "2026-10-01T12:00:00Z"), at("new", "2026-10-01T12:04:00Z")];
  const now = Date.parse("2026-10-01T12:05:00Z");

  it("goes once it is older than the chosen time", () => {
    expect(expiredNotifications(items, 300, now).map((item) => item.id)).toEqual(["old"]);
    expect(nextExpiry(items, 300)).toBe(Date.parse("2026-10-01T12:05:00Z"));
  });

  it("never goes while the time is zero", () => {
    expect(expiredNotifications(items, 0, now)).toEqual([]);
    expect(nextExpiry(items, 0)).toBeNull();
  });

  it("stays when its timestamp cannot be read", () => {
    expect(expiredNotifications([at("odd", "yesterday")], 1, now)).toEqual([]);
  });
});
