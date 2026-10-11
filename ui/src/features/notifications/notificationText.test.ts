import { afterEach, describe, expect, it } from "vitest";
import type { ClientNotification } from "../../ipc/bindings";
import { de } from "../../i18n/catalog/de";
import { en } from "../../i18n/catalog/en";
import { resetLocaleForTests, setLocale } from "../../i18n/store";
import { notificationBody, notificationBodyDetail, notificationTitle } from "./notificationText";

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

describe("a failure notification's reason", () => {
  afterEach(() => resetLocaleForTests());

  const offline = "error sending request for url (https://github.com/FAForever/Neroxis-Map-Generator/releases/latest)";

  function failure(key: string, reason: string, params: Record<string, string> = {}): ClientNotification {
    return item({
      kind: "error",
      title: "Map generation failed",
      body: reason,
      text: { key, params: { ...params, reason } },
    });
  }

  it("is said plainly when the backend marks it, with the original kept for the tooltip", () => {
    const failed = failure("notifications.msg.mapGenerationFailed", offline);
    expect(notificationBody(failed)).toBe(en["errors.cause.offline"]);
    expect(notificationBodyDetail(failed)).toBe(offline);

    setLocale("de");
    expect(notificationTitle(failed)).toBe(de["notifications.msg.mapGenerationFailed.title"]);
    expect(notificationBody(failed)).toBe(de["errors.cause.offline"]);
  });

  it("goes into the entry's own sentence, without a second full stop where the entry carries on", () => {
    const download = failure("notifications.msg.mapDownloadFailed", "HTTP 404 from the content server", {
      folder: "dual_gap.v0004",
    });
    expect(notificationBody(download)).toBe(`dual_gap.v0004 could not be downloaded: ${en["errors.cause.notFound"]}`);

    const upload = failure("notifications.msg.mapNotPublished", offline, { name: "Dual Gap" });
    expect(notificationBody(upload)).toBe(
      `Dual Gap could not be published: ${en["errors.cause.offline"].replace(/\.$/, "")}. Open the upload again to retry.`,
    );
    expect(notificationBodyDetail(upload)).toBe(offline);
  });

  it("leaves a body the backend did not mark as it was sent, such as the server's own words", () => {
    const kick = item({
      kind: "error",
      title: "Disconnected by server",
      body: "You timed out of 3 games on 2026/10/08 and are banned for a day.",
      text: { key: "notifications.msg.serverKick", params: {} },
    });
    expect(notificationBody(kick)).toBe(kick.body);
    expect(notificationBodyDetail(kick)).toBeNull();
  });

  it("has no tooltip when the plain sentence is the reason itself", () => {
    const own = failure("notifications.msg.mapGenerationFailed", "The generator needs Java 21 or newer.");
    expect(notificationBody(own)).toBe("The generator needs Java 21 or newer.");
    expect(notificationBodyDetail(own)).toBeNull();
  });

  // The replay, search and host failures carry the client's own reason as
  // well, and are marked the same way by the backend.
  it.each([
    ["notifications.msg.replayFailed", "Replay fehlgeschlagen"],
    ["notifications.msg.searchFailed", "Suche konnte nicht gestartet werden"],
    ["notifications.msg.hostFailed", "Partie konnte nicht gehostet werden"],
  ])("is said plainly for %s, under its translated title", (key, germanTitle) => {
    const failed = failure(key, offline);
    expect(notificationBody(failed)).toBe(en["errors.cause.offline"]);
    expect(notificationBodyDetail(failed)).toBe(offline);

    setLocale("de");
    expect(notificationTitle(failed)).toBe(germanTitle);
    expect(notificationBody(failed)).toBe(de["errors.cause.offline"]);
  });
});

describe("the generator's notice that it cannot resolve a name", () => {
  afterEach(() => resetLocaleForTests());

  const notice = item({
    kind: "error",
    title: "This generator cannot resolve a name",
    body: "Working the map name out from the options needs generator 1.22.0 or newer. Generating still works.",
    text: { key: "notifications.msg.generatorCannotParse", params: { version: "1.22.0" } },
  });

  it("names the version it needs, in the reader's language", () => {
    expect(notificationTitle(notice)).toBe("This generator cannot resolve a name");
    expect(notificationBody(notice)).toBe(notice.body);

    setLocale("de");
    expect(notificationTitle(notice)).toBe("Dieser Generator kann keinen Namen ermitteln");
    expect(notificationBody(notice)).toContain("Generator 1.22.0 oder neuer");
    expect(notificationBodyDetail(notice)).toBeNull();
  });
});
