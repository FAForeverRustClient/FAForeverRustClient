// @vitest-environment happy-dom
//
// "Check for updates" on the installed mods, mounted.
//
// The check reloads the mod catalogue and then says what it found. The reload
// can be called off from the status bar, and a check called off used to report
// on the catalogue it had been asked to replace ("Every installed mod is up to
// date", or a count) as if it had looked.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../testing/mounted";
import { InstalledModsView } from "./InstalledModsView";

vi.mock("../../ipc/client");

failOnConsoleError();

/** Version 11 on disk. */
const installed: InstalledMod = {
  folderName: "roguelike",
  uid: "old-uid",
  displayName: "Roguelike Mode",
  version: "11",
  author: "Nuggets",
  description: "",
  modType: "sim",
  enabled: true,
};

/** Version 12 in the vault: an update for the one on disk. */
const latest: VaultMod = {
  modId: 1,
  versionId: 12,
  displayName: "Roguelike Mode",
  author: "Nuggets",
  uploader: "Nuggets",
  uploaderId: 1,
  uid: "new-uid",
  version: "12",
  description: "",
  filename: "roguelike.v0012.zip",
  modType: "sim",
  ranked: false,
  recommended: false,
  ratingTenths: 0,
  reviews: 0,
  createdAt: "",
  updatedAt: "",
  downloadUrl: "https://content.faforever.com/mods/roguelike.v0012.zip",
  thumbnailUrl: "",
};

/** The installed mods with a catalogue loaded, and a check started. */
function startCheck() {
  seedStore((state) => ({
    ...state,
    mods: {
      ...state.mods,
      installed: [installed],
      installedStatus: { type: "ready" },
      vault: [latest],
      vaultStatus: { type: "ready" },
    },
  }));
  render(<InstalledModsView busy={false} onOpenInVault={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(sentCommands()).toContainEqual({ kind: "Mods", command: { type: "reloadVault" } });
  applyEvent({ kind: "Mods", event: { type: "vaultLoading" } });
}

describe("checking the installed mods for updates", () => {
  it("says what a finished reload found", () => {
    startCheck();
    applyEvent({ kind: "Mods", event: { type: "vaultLoaded", payload: { mods: [latest] } } });

    expect(screen.getByText("1 mod has an update.")).toBeTruthy();
  });

  it("says nothing when the reload is called off", () => {
    startCheck();
    applyEvent({ kind: "Mods", event: { type: "vaultCancelled" } });

    expect(screen.queryByText("1 mod has an update.")).toBeNull();
    expect(screen.queryByText("Every installed mod is up to date.")).toBeNull();
    // And the button is a button again, not "Checking…".
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  });
});
