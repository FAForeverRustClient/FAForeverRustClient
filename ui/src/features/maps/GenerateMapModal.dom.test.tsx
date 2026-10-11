// @vitest-environment happy-dom
//
// The Generate Map dialog opened from the Host Game dialog's map column,
// mounted with the host dialog under it. That pair is the case the overlay
// stack was written for: one press of Escape used to close both. Here the
// generator opens on top and takes focus, Escape closes it alone and gives
// focus back to the button that opened it, a dropdown open inside it is a
// third layer that Escape reaches first, and a run goes out as one `generate`
// command whose result can be handed back to the host dialog.
//
// Not covered, because happy-dom has no layout: Tab staying inside the
// topmost dialog (the trap finds visible controls through `offsetParent`,
// which happy-dom never sets), and the preview zoom's panning.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GeneratorStatus, InstalledMap } from "../../ipc/bindings";
import { overlayStack } from "../../design-system/overlayStack";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, initialState, seedStore, sentCommands } from "../../testing/mounted";
import { HostGameModal } from "../lobby/host/HostGameModal";

vi.mock("../../ipc/client");

failOnConsoleError();

const installed: InstalledMap[] = [
  { folderName: "zz_alpha.v0001", displayName: "Zz Alpha", maxPlayers: 2, width: 256, height: 256 },
];

const GENERATED = "neroxis_map_generator_1.12.0_abcdefgh_aiea";

function mountHost() {
  seedStore((state) => ({ ...state, maps: { ...state.maps, installed } }));
  const onClose = vi.fn();
  render(<HostGameModal onClose={onClose} />);
  clearSentCommands();
  return { onClose, opener: screen.getByRole("button", { name: /^Generate map/ }) };
}

/** The dialogs open, bottom first: they are portalled to the body in the order they opened. */
function dialogs() {
  return screen.getAllByRole("dialog");
}

/** The generator's dialog, by its name; the host dialog has its own. */
function generatorDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Generate a map" });
}

/** The dropdown in one of the generator's rows, by its name: its row's label. */
function rowCombobox(dialog: HTMLElement, rowLabel: string): HTMLElement {
  return within(dialog).getByRole("combobox", { name: rowLabel });
}

describe("Generate Map over Host Game, mounted", () => {
  it("opens on top of the host dialog, takes focus, and asks for the generator's options", async () => {
    const user = userEvent.setup();
    const { opener } = mountHost();
    expect(dialogs()).toHaveLength(1);
    const host = dialogs()[0];

    await user.click(opener);
    expect(dialogs()).toHaveLength(2);
    const generator = generatorDialog();
    // Opened last, so drawn last, over the host dialog. Each is named, so a
    // screen reader can tell them apart; both used to be "Dialog".
    expect(dialogs()).toEqual([host, generator]);
    expect(host.getAttribute("aria-label")).toBe("Host a custom game");
    expect(generator.getAttribute("aria-label")).toBe("Generate a map");
    for (const name of ["Generator version", "Map size", "Teams", "Spawns", "Style of game", "Preset"]) {
      expect(within(generator).getByRole("combobox", { name })).toBeDefined();
    }
    expect(overlayStack.size()).toBe(2);
    expect(generator.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(generator).getByRole("textbox", { name: "Full map name" }));

    expect(sentCommands()).toEqual(
      expect.arrayContaining([
        { kind: "MapGenerator", command: { type: "loadOptions", payload: { version: null } } },
        expect.objectContaining({ kind: "MapGenerator", command: expect.objectContaining({ type: "loadPresets" }) as unknown }),
      ]),
    );
  });

  it("closes on Escape alone, gives focus back to the button that opened it, and leaves Escape to the host next", async () => {
    const user = userEvent.setup();
    const { onClose, opener } = mountHost();

    opener.focus();
    await user.keyboard("{Enter}");
    const generator = generatorDialog();
    expect(generator.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(generator.isConnected).toBe(false);
    expect(dialogs()).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    expect(overlayStack.size()).toBe(1);

    // The host dialog is still there to take the next press.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives focus back to the opener when closed with either of its Close buttons too", async () => {
    const user = userEvent.setup();
    const { onClose, opener } = mountHost();

    // The dialog's corner button and the one beside Generate share the name.
    for (const which of ["corner", "actions"] as const) {
      await user.click(opener);
      const closers = within(generatorDialog()).getAllByRole("button", { name: "Close" });
      expect(closers).toHaveLength(2);
      const closer = closers.find((button) => button.classList.contains("modal-close") === (which === "corner"));
      await user.click(closer as HTMLElement);
      expect(dialogs(), which).toHaveLength(1);
      expect(document.activeElement, which).toBe(opener);
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it("gives Escape to a dropdown open inside it first, then to itself, then to the host", async () => {
    const user = userEvent.setup();
    const { onClose, opener } = mountHost();

    await user.click(opener);
    const generator = generatorDialog();
    const mapSize = rowCombobox(generator, "Map size");
    mapSize.focus();
    await user.keyboard("{Enter}");
    expect(mapSize.getAttribute("aria-expanded")).toBe("true");
    expect(overlayStack.size()).toBe(3);

    await user.keyboard("{Escape}");
    expect(mapSize.getAttribute("aria-expanded")).toBe("false");
    expect(generator.isConnected).toBe(true);
    expect(document.activeElement).toBe(mapSize);

    await user.keyboard("{Escape}");
    expect(generator.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(onClose).not.toHaveBeenCalled();
    // Only the host dialog's own layer is left.
    expect(overlayStack.size()).toBe(1);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a pasted map name on Enter, and only that", async () => {
    const user = userEvent.setup();
    const { onClose, opener } = mountHost();

    await user.click(opener);
    const generator = generatorDialog();
    const name = within(generator).getByRole("textbox", { name: "Full map name" });
    expect(document.activeElement).toBe(name);
    clearSentCommands();

    await user.keyboard(`${GENERATED}{Enter}`);
    expect(sentCommands()).toEqual([
      { kind: "MapGenerator", command: { type: "generateNamed", payload: { mapName: GENERATED } } },
    ]);
    // Enter submitted the generator's form and nothing behind it.
    expect(generator.isConnected).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends the options on screen as one generate command, and hands the result back to the host dialog", async () => {
    const user = userEvent.setup();
    const { opener } = mountHost();

    await user.click(opener);
    const generator = generatorDialog();
    clearSentCommands();
    await user.click(within(generator).getByRole("button", { name: "Generate" }));
    expect(sentCommands()).toEqual([
      {
        kind: "MapGenerator",
        command: { type: "generate", payload: { options: initialState().mapGenerator.options } },
      },
    ]);

    // The backend answers with the run's progress and then its result.
    const status = (next: GeneratorStatus) =>
      applyEvent({ kind: "MapGenerator", event: { type: "statusChanged", payload: { status: next } } });
    status({ type: "generating", payload: { version: "1.12.0", detail: "" } });
    expect(within(generator).getByRole<HTMLButtonElement>("button", { name: "Working…" }).disabled).toBe(true);
    status({ type: "generated", payload: { maps: [GENERATED] } });
    expect(sentCommands()).toContainEqual({
      kind: "MapGenerator",
      command: { type: "decodeNames", payload: { mapNames: [GENERATED] } },
    });

    clearSentCommands();
    await user.click(within(generator).getByRole("button", { name: "Use map" }));
    expect(generator.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
    // The host dialog rescans the installed maps and selects the new one.
    expect(sentCommands()).toContainEqual({ kind: "Maps", command: { type: "loadInstalled" } });
    const list = screen.getByRole("listbox", { name: "Available maps" });
    expect(within(list).getByRole("option", { name: new RegExp(GENERATED) }).getAttribute("aria-selected")).toBe("true");
  });
});
