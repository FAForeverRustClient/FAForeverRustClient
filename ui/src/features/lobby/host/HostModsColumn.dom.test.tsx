// @vitest-environment happy-dom
//
// The host dialog's mods column, mounted: the active mods of a kind lead its
// tab (#466), and a mod switched from its own checkbox stays where it is until
// the list is shown afresh, so the row under the pointer does not run away.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InstalledMod } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../../testing/mounted";
import { HostModsColumn } from "./HostModsColumn";

vi.mock("../../../ipc/client");

failOnConsoleError();

function mod(uid: string, displayName: string, modType: InstalledMod["modType"], enabled: boolean): InstalledMod {
  return { folderName: uid, uid, displayName, version: "1", author: "Author", description: "", modType, enabled };
}

// The report's case: one sim mod on, and it sorts last by name.
const installed: InstalledMod[] = [
  mod("ui-alpha", "Alpha UI", "ui", true),
  mod("ui-beta", "Beta UI", "ui", false),
  mod("sim-quantum", "All Faction Quantum Gate", "sim", false),
  mod("sim-barhan", "Barhan ACU Boost", "sim", false),
  mod("sim-mayhem", "Total Mayhem", "sim", true),
];

function mount(mods: InstalledMod[] = installed) {
  seedStore((state) => ({ ...state, mods: { ...state.mods, installed: mods } }));
  render(<HostModsColumn />);
}

/** The mod names in the list, top to bottom. */
function listedMods(): string[] {
  return screen
    .getAllByRole("checkbox")
    .map((box) => box.closest("label")?.querySelector(".host-mod-name")?.textContent ?? "");
}

async function openTab(user: ReturnType<typeof userEvent.setup>, kind: RegExp) {
  await user.click(screen.getByRole("tab", { name: kind }));
}

describe("HostModsColumn, mounted", () => {
  it("lists the active sim mods first on the Sim tab", async () => {
    const user = userEvent.setup();
    mount();
    await openTab(user, /^Sim Mods/);

    expect(listedMods()).toEqual(["Total Mayhem", "All Faction Quantum Gate", "Barhan ACU Boost"]);
  });

  it("pins the active mods of a list that arrives after the column opened", async () => {
    const user = userEvent.setup();
    mount([]);
    applyEvent({ kind: "Mods", event: { type: "installedLoaded", payload: { mods: installed } } });
    await openTab(user, /^Sim Mods/);

    expect(listedMods()).toEqual(["Total Mayhem", "All Faction Quantum Gate", "Barhan ACU Boost"]);
  });

  it("keeps a switched mod in its place, and pins it once the tab is opened again", async () => {
    const user = userEvent.setup();
    mount();
    await openTab(user, /^Sim Mods/);

    await user.click(screen.getByRole("checkbox", { name: /^Barhan ACU Boost/ }));
    expect(sentCommands()).toContainEqual({
      kind: "Mods",
      command: { type: "toggleMod", payload: { uid: "sim-barhan", enabled: true } },
    });
    applyEvent({
      kind: "Mods",
      event: {
        type: "toggled",
        payload: { installed: installed.map((m) => (m.uid === "sim-barhan" ? { ...m, enabled: true } : m)) },
      },
    });

    // Switched on, and still the third row.
    expect(listedMods()).toEqual(["Total Mayhem", "All Faction Quantum Gate", "Barhan ACU Boost"]);
    expect(screen.getByRole("checkbox", { name: /^Barhan ACU Boost/ })).toHaveProperty("checked", true);

    await openTab(user, /^UI Mods/);
    await openTab(user, /^Sim Mods/);
    expect(listedMods()).toEqual(["Barhan ACU Boost", "Total Mayhem", "All Faction Quantum Gate"]);
  });
});
