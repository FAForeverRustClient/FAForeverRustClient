// @vitest-environment happy-dom
//
// The host dialog's map picker, mounted: keyboard selection, the filter
// popover's dismissal (outside click and Escape, in that order of layers), the
// listener it holds while open, and a favourite that only shows once the
// backend has acknowledged it.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { InstalledMap } from "../../../ipc/bindings";
import { applyEvent, initialState, seedStore, sentCommands } from "../../../testing/mounted";
import { HostGameModal } from "./HostGameModal";

vi.mock("../../../ipc/client");

const installed: InstalledMap[] = [
  { folderName: "zz_gamma.v0001", displayName: "Zz Gamma", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "zz_alpha.v0001", displayName: "Zz Alpha", maxPlayers: 2, width: 256, height: 256 },
  { folderName: "zz_beta.v0001", displayName: "Zz Beta", maxPlayers: 8, width: 1024, height: 1024 },
];

function mountDialog() {
  seedStore((state) => ({ ...state, maps: { ...state.maps, installed } }));
  const onClose = vi.fn();
  const view = render(<HostGameModal onClose={onClose} />);
  return { onClose, ...view };
}

/** Narrow the list to the three seeded maps. The picker remembers its search for the session. */
async function showSeededMaps(user: ReturnType<typeof userEvent.setup>) {
  const search = screen.getByRole("textbox", { name: "Search maps" });
  await user.clear(search);
  await user.type(search, "Zz ");
  const list = screen.getByRole("listbox", { name: "Available maps" });
  return within(list).getAllByRole("option");
}

/** How many `mousedown` listeners added to the document are still attached. */
function mousedownListeners(spies: { add: { mock: { calls: unknown[][] } }; remove: { mock: { calls: unknown[][] } } }) {
  const live = new Set<unknown>();
  for (const [type, listener] of spies.add.mock.calls) if (type === "mousedown") live.add(listener);
  for (const [type, listener] of spies.remove.mock.calls) if (type === "mousedown") live.delete(listener);
  return live.size;
}

describe("HostGameModal map picker, mounted", () => {
  it("asks for the installed maps, the vault and the installed mods when it opens", () => {
    mountDialog();
    expect(sentCommands()).toEqual(
      expect.arrayContaining([
        { kind: "Maps", command: { type: "loadInstalled" } },
        { kind: "Maps", command: { type: "loadVault" } },
        { kind: "Mods", command: { type: "loadInstalled" } },
      ]),
    );
  });

  it("moves the selection and the focus together with the arrow keys, without wrapping", async () => {
    const user = userEvent.setup();
    mountDialog();
    const options = await showSeededMaps(user);
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Zz Alpha"),
      expect.stringContaining("Zz Beta"),
      expect.stringContaining("Zz Gamma"),
    ]);

    await user.click(options[0]);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    await user.keyboard("{ArrowDown}");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(document.activeElement).toBe(options[1]);

    await user.keyboard("{End}");
    expect(options[2].getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowDown}");
    expect(options[2].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(options[2]);

    await user.keyboard("{Home}");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(options[0]);
  });

  it("closes the filter popover on a click outside it, and lets go of its listener", async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    mountDialog();

    const filterButton = screen.getByRole("button", { name: "Filter" });
    await user.click(filterButton);
    expect(filterButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeDefined();
    expect(mousedownListeners({ add, remove })).toBe(1);

    // Inside the popover: it stays.
    await user.click(screen.getByRole("group", { name: "Rated games" }));
    expect(filterButton.getAttribute("aria-expanded")).toBe("true");

    // Outside it, on another field of the same dialog: it closes, the dialog does not.
    await user.click(screen.getByRole("textbox", { name: "Game title" }));
    expect(filterButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(mousedownListeners({ add, remove })).toBe(0);

    add.mockRestore();
    remove.mockRestore();
  });

  it("gives Escape to the open filter popover before the dialog", async () => {
    const user = userEvent.setup();
    const { onClose } = mountDialog();

    const filterButton = screen.getByRole("button", { name: "Filter" });
    await user.click(filterButton);
    await user.keyboard("{Escape}");
    expect(filterButton.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    // Closing remembers the form, through the backend like any other setting.
    expect(sentCommands()).toContainEqual(
      expect.objectContaining({
        kind: "Settings",
        command: expect.objectContaining({ type: "patchBrowsing" }) as unknown,
      }),
    );
  });

  it("sends a favourite and shows it once the backend's settings say so", async () => {
    const user = userEvent.setup();
    mountDialog();
    await showSeededMaps(user);

    const star = screen.getByRole("button", { name: "Add Zz Beta to favourites" });
    expect(star.getAttribute("aria-pressed")).toBe("false");
    await user.click(star);

    expect(sentCommands()).toContainEqual({
      kind: "Settings",
      command: {
        type: "setListMember",
        payload: { list: "favoriteMaps", value: "zz_beta.v0001", member: true },
      },
    });
    // Nothing is assumed: the star waits for the settings to come back.
    expect(star.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("tab", { name: "Favourites (0)" })).toBeDefined();

    applyEvent({
      kind: "Settings",
      event: {
        type: "browsingChanged",
        payload: {
          preferences: { ...initialState().settings.browsing, favoriteMaps: ["zz_beta.v0001"] },
        },
      },
    });

    expect(screen.getByRole("button", { name: "Remove Zz Beta from favourites" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("tab", { name: "Favourites (1)" })).toBeDefined();
  });
});
