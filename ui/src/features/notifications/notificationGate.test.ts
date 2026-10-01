import { describe, expect, it } from "vitest";
import type { ClientNotification } from "../../ipc/bindings";
import { happensInView } from "./notificationGate";

function message(kind: ClientNotification["kind"], channel: string): ClientNotification {
  return {
    id: "1",
    kind,
    title: "Message from Someone",
    body: "hi",
    createdAt: "2026-10-01T12:00:00Z",
    read: false,
    action: { type: "openChat", payload: { channel } },
  } as ClientNotification;
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
