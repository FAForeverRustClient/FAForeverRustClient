// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerProfile, PlayerSummary } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { EntrantName } from "./EntrantName";
import { PlayerTable } from "./PlayerTable";
import { player, tourney } from "./fixtures";

vi.mock("../../ipc/client");
failOnConsoleError();

const profile: PlayerSummary = {
  id: 7, login: "Alice", avatarUrl: "https://example.invalid/avatar.png",
  country: "de", globalRating: 1800, ladderRating: null,
};

function mountName() {
  seedStore((state) => ({ ...state, social: { ...state.social, players: [] } }));
  render(<EntrantName name="Tournament alias" fafId={7} profile={profile} />);
  return screen.getByRole("button", { name: /Tournament alias/ });
}

describe("tournament entrant player menu", () => {
  it("opens the standard menu from the Players table and uses an offline account's identity", async () => {
    const user = userEvent.setup();
    const entrant = player({ id: "p1", fafId: 7, name: "Tournament alias" });
    const event = tourney({ players: [entrant] });
    seedStore((state) => ({ ...state, social: { ...state.social, players: [] } }));
    render(<PlayerTable event={event} players={event.players} profiles={[profile]} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Tournament alias/ }));
    expect(screen.getByRole("menu")).toBeDefined();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.contextMenu(screen.getByRole("menu"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(sentCommands()).toEqual([]);
    await user.click(screen.getByRole("menuitem", { name: "Add friend" }));
    expect(sentCommands()).toEqual([{
      kind: "Social", command: { type: "setRelation", payload: { playerId: 7, login: "Alice", relation: "friend", member: true } },
    }]);
  });

  it("also opens from other cells in the player row", () => {
    const entrant = player({ id: "p1", fafId: 7, name: "Tournament alias", rating: 1640 });
    const event = tourney({ players: [entrant] });
    render(<PlayerTable event={event} players={event.players} profiles={[profile]} />);
    const rating = screen.getByRole("cell", { name: "1640" });
    fireEvent.contextMenu(rating);
    expect(screen.getByRole("menu")).toBeDefined();
    expect(rating.closest("tr")?.classList.contains("is-menu-target")).toBe(true);
  });

  it("keeps the existing player-card action on a normal click", async () => {
    const user = userEvent.setup();
    const name = mountName();
    await user.click(name);
    expect(sentCommands()).toEqual([{
      kind: "PlayerCard", command: { type: "open", payload: { playerId: 7, login: "Alice" } },
    }]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens from the avatar and keeps its source marked until Escape", async () => {
    const user = userEvent.setup();
    const name = mountName();
    name.focus();
    fireEvent.contextMenu(name.querySelector("img")!);
    expect(name.classList.contains("is-menu-target")).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(name.classList.contains("is-menu-target")).toBe(false);
    expect(document.activeElement).toBe(name);
  });

  it.each([{ key: "F10", shiftKey: true }, { key: "ContextMenu", shiftKey: false }])(
    "opens with the keyboard using $key",
    (keys) => {
      const name = mountName();
      name.focus();
      expect(fireEvent.keyDown(name, keys)).toBe(false);
      expect(screen.getByRole("menu")).toBeDefined();
      expect(sentCommands()).toEqual([]);
    },
  );

  it("resolves a legacy unlinked name through the existing player lookup", async () => {
    const user = userEvent.setup();
    render(<EntrantName name="LegacyPlayer" fafId={null} profile={null} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "LegacyPlayer" }));
    expect(sentCommands()).toEqual([{
      kind: "Social", command: { type: "lookUpLogin", payload: { login: "LegacyPlayer" } },
    }]);
    expect(screen.getByRole("menuitem", { name: "Add foe" }).hasAttribute("disabled")).toBe(true);
    applyEvent({ kind: "Social", event: { type: "loginLookedUp", payload: { login: "LegacyPlayer", id: 22 } } });
    clearSentCommands();
    await user.click(screen.getByRole("menuitem", { name: "Add foe" }));
    expect(sentCommands()).toEqual([{
      kind: "Social", command: { type: "setRelation", payload: { playerId: 22, login: "LegacyPlayer", relation: "foe", member: true } },
    }]);
  });

  it("uses a matching online account's current login after a rename", async () => {
    const user = userEvent.setup();
    const online: PlayerProfile = {
      id: 7, login: "RenamedAlice", globalRating: 1800, ratings: [], country: "de",
      clan: "", avatarUrl: "", avatarTooltip: "",
    };
    seedStore((state) => ({ ...state, social: { ...state.social, players: [online] } }));
    render(<EntrantName name="Tournament alias" fafId={7} profile={profile} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Tournament alias/ }));
    await user.click(screen.getByRole("menuitem", { name: "Private message" }));
    expect(sentCommands()).toContainEqual({
      kind: "Chat", command: { type: "joinChannel", payload: { channel: "RenamedAlice" } },
    });
  });
});
