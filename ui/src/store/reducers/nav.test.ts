// Tests for the frontend navigation reducer, the twin of
// `faf_domain::state::nav::reduce`.
//
// The sections are what is worth pinning: Maps, Mods, Replays and Settings
// read their open section from here, and a section that a tab change reset (or
// that leaked into another destination) is exactly the bug this state exists
// to prevent.

import { describe, expect, it } from "vitest";
import type { NavEvent, NavState } from "../../ipc/bindings";
import { useAppStore } from "../store";
import { reduceNav } from "./core";

function apply(state: NavState, events: NavEvent[]): NavState {
  return events.reduce(reduceNav, state);
}

describe("reduceNav", () => {
  it("opens every destination on its first section, as the Rust default does", () => {
    expect(useAppStore.getState().state.nav).toEqual({
      activeTab: "news",
      mapsSection: "vault",
      modsSection: "vault",
      replaysSection: "online",
      settingsSection: "general",
    });
  });

  it("keeps a section across leaving its tab and coming back", () => {
    const next = apply(useAppStore.getState().state.nav, [
      { type: "tabSelected", payload: { tab: "maps" } },
      { type: "mapsSectionSelected", payload: { section: "installed" } },
      { type: "tabSelected", payload: { tab: "chat" } },
      { type: "tabSelected", payload: { tab: "maps" } },
    ]);
    expect(next.activeTab).toBe("maps");
    expect(next.mapsSection).toBe("installed");
  });

  it("keeps each destination's section separate", () => {
    const next = apply(useAppStore.getState().state.nav, [
      { type: "modsSectionSelected", payload: { section: "installed" } },
      { type: "replaysSectionSelected", payload: { section: "local" } },
      { type: "settingsSectionSelected", payload: { section: "cache" } },
    ]);
    expect(next).toEqual({
      activeTab: "news",
      mapsSection: "vault",
      modsSection: "installed",
      replaysSection: "local",
      settingsSection: "cache",
    });
  });
});
