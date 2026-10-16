// @vitest-environment happy-dom
//
// The player menu through `usePlayerMenu`, as every view opens it: an offline
// player gets the same account entries as an online one, greyed out until
// their account is looked up; a name with no account gets none of them; "Mute
// player" is gone, and only somebody muted before can still be unmuted; and
// "Add foe" says what being a foe does.

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerProfile } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { Modal } from "../../design-system/Modal";
import { usePlayerMenu } from "../hooks/usePlayerMenu";

vi.mock("../../ipc/client");

failOnConsoleError();

function Harness({ name }: { name: string }) {
  const { openPlayerMenu, playerMenu } = usePlayerMenu();
  return (
    <>
      <span onContextMenu={(event) => openPlayerMenu(name, event)}>{name}</span>
      {playerMenu}
    </>
  );
}

const online: PlayerProfile = {
  id: 7,
  login: "Alice",
  globalRating: 1500,
  ratings: [],
  country: "de",
  clan: "",
  avatarUrl: "",
  avatarTooltip: "",
};

function openMenu(name: string, mutedPlayers: string[] = [], nameColor?: string) {
  seedStore((state) => ({
    ...state,
    social: { ...state.social, players: [online] },
    settings: {
      ...state.settings,
      chat: {
        ...state.settings.chat,
        mutedPlayers,
        nameColors: {
          ...state.settings.chat.nameColors,
          players: nameColor ? { [name.toLowerCase()]: nameColor } : {},
        },
      },
    },
  }));
  render(<Harness name={name} />);
  clearSentCommands();
  fireEvent.contextMenu(screen.getByText(name));
}

const entry = (name: string) => screen.getByRole("menuitem", { name });
const lookedUp = (login: string, id: number | null) =>
  applyEvent({ kind: "Social", event: { type: "loginLookedUp", payload: { login, id } } });

describe("player menu", () => {
  it("closes the colour picker, player menu and surrounding dialog one Escape at a time", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Replay"><Harness name="Alice" /></Modal>);
    fireEvent.contextMenu(screen.getByText("Alice"));
    const trigger = screen.getByRole("button", { name: "Choose a name color for Alice" });
    await user.keyboard("{Tab}{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const picker = screen.getByRole("dialog", { name: "Choose a name color for Alice" });
    expect(document.activeElement).toBe(within(picker).getAllByRole("slider")[0]);
    await user.keyboard("{Tab}{Tab}");
    expect(document.activeElement).toBe(within(picker).getByRole("textbox"));
    await user.keyboard("{Escape}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers an offline player every account entry, greyed out until the account is found", async () => {
    const user = userEvent.setup();
    openMenu("Bob");

    expect(sentCommands()).toEqual([
      { kind: "Social", command: { type: "lookUpLogin", payload: { login: "Bob" } } },
    ]);
    for (const name of ["Edit private note", "Add friend", "Add foe", "Report player"]) {
      expect((entry(name) as HTMLButtonElement).disabled).toBe(true);
      expect(entry(name).title).toBe("Looking up the account…");
    }
    expect((entry("View replays") as HTMLButtonElement).disabled).toBe(false);

    lookedUp("Bob", 42);

    expect((entry("Add foe") as HTMLButtonElement).disabled).toBe(false);
    clearSentCommands();
    await user.click(entry("Add foe"));
    expect(sentCommands()).toEqual([
      {
        kind: "Social",
        command: { type: "setRelation", payload: { playerId: 42, login: "Bob", relation: "foe", member: true } },
      },
    ]);
  });

  it("gives a name with no account only what needs no account", () => {
    openMenu("ircbot");
    lookedUp("ircbot", null);

    for (const name of ["View replays", "Edit private note", "Add friend", "Add foe", "Report player"]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull();
    }
    expect(entry("Private message")).toBeTruthy();
    expect(entry("Copy username")).toBeTruthy();
  });

  it("asks nothing for an online player and explains what a foe is", () => {
    openMenu("Alice");

    expect(sentCommands()).toEqual([]);
    expect((entry("Add foe") as HTMLButtonElement).disabled).toBe(false);
    expect(entry("Add foe").title).toMatch(/^With “Hide foe messages” on/);
  });

  it("no longer mutes, but still unmutes somebody muted before", () => {
    openMenu("Alice");
    expect(screen.queryByRole("menuitem", { name: "Mute player" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Unmute player" })).toBeNull();
  });

  it("offers Unmute for a player muted before the change", () => {
    openMenu("Alice", ["Alice"]);
    expect(entry("Unmute player")).toBeTruthy();
  });

  it("reaches the name colour with Tab and closes once Tab leaves the menu", async () => {
    const user = userEvent.setup();
    openMenu("Alice");
    const items = screen.getAllByRole("menuitem").filter((item) => !(item as HTMLButtonElement).disabled);
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    const colour = screen.getByRole("button", { name: "Choose a name color for Alice" });
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(colour);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{Tab}{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it.each([undefined, "#abcdef"])("edits the name colour by keyboard with an existing colour of %s", async (nameColor) => {
    const user = userEvent.setup();
    openMenu("Alice", [], nameColor);
    const trigger = screen.getByRole("button", { name: "Choose a name color for Alice" });
    await user.keyboard("{Tab}{Enter}");
    const picker = screen.getByRole("dialog", { name: "Choose a name color for Alice" });
    const [shade, hue] = within(picker).getAllByRole("slider");
    const hex = within(picker).getByRole("textbox");
    expect(document.activeElement).toBe(shade);
    await user.keyboard("{ArrowRight}{Tab}");
    expect(document.activeElement).toBe(hue);
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(hex);
    clearSentCommands();
    await user.clear(hex);
    await user.type(hex, "#123456");
    expect(sentCommands()).toContainEqual({
      kind: "Settings",
      command: { type: "setPlayerNameColor", payload: { player: "Alice", color: "#123456" } },
    });
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(shade);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(hex);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Tab}");
    if (nameColor) {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear" }));
      clearSentCommands();
      await user.keyboard("{Enter}");
      expect(sentCommands()).toContainEqual({
        kind: "Settings",
        command: { type: "setPlayerNameColor", payload: { player: "Alice", color: null } },
      });
      expect(document.activeElement).toBe(trigger);
      // The mocked store keeps the colour, so Clear stays enabled here.
      await user.keyboard("{Tab}{Tab}");
    }
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the player menu open for pointer input inside its colour picker", async () => {
    const user = userEvent.setup();
    openMenu("Alice");
    await user.click(screen.getByRole("button", { name: "Choose a name color for Alice" }));
    const picker = screen.getByRole("dialog", { name: "Choose a name color for Alice" });
    const hex = within(picker).getByRole("textbox");
    await user.clear(hex);
    await user.type(hex, "#123456");
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(picker);
    expect(sentCommands()).toContainEqual({
      kind: "Settings",
      command: { type: "setPlayerNameColor", payload: { player: "Alice", color: "#123456" } },
    });
    await user.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
