// Which tabs a session may open, and which one it lands on. Pure functions
// rather than a rendered bar: this file's twin renders on the server, where
// zustand answers every selector from `getInitialState()` and a session built
// with `setState` never reaches the component.

import { describe, expect, it } from "vitest";
import { OFFLINE_TABS, openTabForMode, TAB_ORDER, tabsForMode } from "./tabs";

describe("the tabs a session may open", () => {
  it("gives an account session the whole registry", () => {
    expect(tabsForMode("account")).toEqual(TAB_ORDER);
    expect(tabsForMode("test")).toEqual(TAB_ORDER);
  });

  it("gives an offline session only what never asks the server anything", () => {
    expect(tabsForMode("offline")).toEqual(OFFLINE_TABS);
    expect(tabsForMode("offline")).toContain("replays");
    expect(tabsForMode("offline")).toContain("settings");
    expect(tabsForMode("offline")).not.toContain("chat");
    expect(tabsForMode("offline")).not.toContain("leaderboard");
  });

  it("keeps the registry's own order rather than inventing one", () => {
    const offline = tabsForMode("offline");
    const positions = offline.map((tab) => TAB_ORDER.indexOf(tab));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});

describe("the tab a session lands on", () => {
  it("keeps the selected one when the session can open it", () => {
    expect(openTabForMode("account", "leaderboard")).toBe("leaderboard");
    expect(openTabForMode("offline", "settings")).toBe("settings");
  });

  it("falls back to the archive when the selected one is shut", () => {
    // The selected tab outlives a session, so an offline session that follows
    // a signed-in one starts on a tab it cannot open. It is projected away,
    // never written over: the account's tab is still selected when it returns.
    expect(openTabForMode("offline", "chat")).toBe("replays");
    expect(openTabForMode("offline", "leaderboard")).toBe("replays");
  });
});
