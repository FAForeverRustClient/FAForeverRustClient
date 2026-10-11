import { afterEach, describe, expect, it } from "vitest";
import type { ClientNotification } from "../../ipc/bindings";
import { resetLocaleForTests, setLocale } from "../../i18n/store";
import { notificationBody, notificationTitle } from "./notificationText";

function item(overrides: Partial<ClientNotification> = {}): ClientNotification {
  return {
    id: "n1",
    kind: "friendOnline",
    title: "Friend online",
    body: "Alice is now online.",
    createdAt: "2026-01-01T00:00:00Z",
    read: false,
    action: null,
    text: { key: "notifications.msg.friendOnline", params: { login: "Alice" } },
    ...overrides,
  };
}

describe("a notification's text (#458)", () => {
  afterEach(() => resetLocaleForTests());

  it("is translated from the catalogue entry the backend attached", () => {
    setLocale("de");
    expect(notificationTitle(item())).toBe("Freund online");
    expect(notificationBody(item())).toBe("Alice ist jetzt online.");
  });

  it("falls back to the English text where the catalogue has no entry", () => {
    setLocale("de");
    const notice = item({
      kind: "serverNotice",
      title: "Message from server",
      body: "Maintenance at noon.",
      text: { key: "notifications.msg.serverInfo", params: {} },
    });
    expect(notificationTitle(notice)).toBe("Nachricht vom Server");
    expect(notificationBody(notice)).toBe("Maintenance at noon.");
    expect(notificationTitle(item({ text: null }))).toBe("Friend online");
    expect(notificationTitle(item({ text: { key: "notifications.msg.unknown", params: {} } }))).toBe("Friend online");
  });

  it("picks the plural form from a numeric parameter", () => {
    const opponent = item({
      kind: "queueOpponent",
      text: { key: "notifications.msg.queueOpponent", params: { count: "1", teamSize: "2" } },
    });
    expect(notificationBody(opponent)).toBe("1 player near your rating is waiting in 2 vs 2.");
  });
});
