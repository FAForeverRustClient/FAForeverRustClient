import { afterEach, describe, expect, it } from "vitest";

import {
  clearSettingsRequest,
  pendingSettingsRequest,
  sectionForNotification,
  requestSettingsSection,
} from "./settingsNavigation";

afterEach(clearSettingsRequest);

describe("opening a section from a notification", () => {
  it("sends the three sections the backend actually asks for to a section", () => {
    // These strings are the protocol: `NotificationAction::OpenSettings` in
    // `services/settings.rs` and `services/client_update.rs` sends exactly
    // these three, for the install messages, the cache alert and the update
    // banner. If one stops resolving, a notification lands nowhere.
    expect(sectionForNotification("paths")).toBe("paths");
    expect(sectionForNotification("gameCache")).toBe("cache");
    expect(sectionForNotification("updates")).toBe("general");
  });

  it("leaves an unknown section where the tab opens rather than guessing", () => {
    expect(sectionForNotification("somethingElse")).toBeNull();

    requestSettingsSection("somethingElse");
    expect(pendingSettingsRequest()).toBeNull();
  });

  it("holds the request until it is taken, so a late mount still sees it", () => {
    // The notification navigates to the tab and the view mounts afterwards, so
    // the request has to survive the gap rather than being delivered to a
    // listener that does not exist yet.
    requestSettingsSection("gameCache");
    expect(pendingSettingsRequest()).toBe("cache");
    expect(pendingSettingsRequest()).toBe("cache");

    clearSettingsRequest();
    expect(pendingSettingsRequest()).toBeNull();
  });

  it("keeps the newest request when two arrive before either is read", () => {
    requestSettingsSection("updates");
    requestSettingsSection("paths");
    expect(pendingSettingsRequest()).toBe("paths");
  });
});
