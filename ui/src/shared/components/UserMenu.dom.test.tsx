// @vitest-environment happy-dom
//
// The player menu through `usePlayerMenu`, as every view opens it: an offline
// player gets the same account entries as an online one, greyed out until
// their account is looked up; a name with no account gets none of them; "Mute
// player" is gone, and only somebody muted before can still be unmuted; and
// "Add foe" says what being a foe does.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerProfile } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
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

function openMenu(name: string, mutedPlayers: string[] = []) {
  seedStore((state) => ({
    ...state,
    social: { ...state.social, players: [online] },
    settings: { ...state.settings, chat: { ...state.settings.chat, mutedPlayers } },
  }));
  render(<Harness name={name} />);
  clearSentCommands();
  fireEvent.contextMenu(screen.getByText(name));
}

const entry = (name: string) => screen.getByRole("menuitem", { name });
const lookedUp = (login: string, id: number | null) =>
  applyEvent({ kind: "Social", event: { type: "loginLookedUp", payload: { login, id } } });

describe("player menu", () => {
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
});
