// @vitest-environment happy-dom
//
// The selected event, mounted against a seeded store: the header's entry
// buttons go out through the grouped command contract (`tourneyActions`) and
// the pane follows the backend's answer rather than assuming it.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Tourney } from "../../ipc/bindings";
import { applyEvent, seedStore, sentCommands } from "../../testing/mounted";
import { tourney } from "./fixtures";
import { TournamentEventDetail } from "./TournamentEventDetail";

vi.mock("../../ipc/client");

const entered = tourney({
  id: "e1a2b",
  name: "Spring Cup",
  status: "signup",
  viewer: { ...tourney().viewer, signedUpPlayerId: "p1" },
});

function mountDetail(event: Tourney) {
  seedStore((state) => ({
    ...state,
    tourney: { ...state.tourney, events: [event], selectedId: event.id, detail: event },
  }));
  const onSignUp = vi.fn();
  render(<TournamentEventDetail jump={null} onOpenPage={() => undefined} onSignUp={onSignUp} onReport={() => undefined} />);
  return { onSignUp };
}

describe("TournamentEventDetail, mounted", () => {
  it("withdraws through the event's command and redraws when the backend's detail says so", async () => {
    const user = userEvent.setup();
    const { onSignUp } = mountDetail(entered);

    expect(screen.getByRole("heading", { name: "Spring Cup" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(sentCommands()).toContainEqual({
      kind: "Tourney",
      command: { type: "withdraw", payload: { tournamentId: "e1a2b" } },
    });
    // Still entered until the service answers.
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDefined();

    applyEvent({
      kind: "Tourney",
      event: {
        type: "detailLoaded",
        payload: { event: { ...entered, viewer: { ...entered.viewer, signedUpPlayerId: null } } },
      },
    });
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();

    // Entering again opens the tab's signup dialog for this event.
    await user.click(screen.getByRole("button", { name: /Enter tournament/ }));
    expect(onSignUp).toHaveBeenCalledWith("e1a2b");
  });

  it("asks for the chat rooms the first time the Chat section opens, and not again", async () => {
    const user = userEvent.setup();
    mountDetail(entered);
    const sections = screen.getByRole("navigation", { name: "Tournament sections" });
    const chat = within(sections).getByRole("button", { name: /^Chat/ });

    await user.click(chat);
    const loads = () => sentCommands().filter((command) => command.kind === "Tourney" && command.command.type === "loadChat");
    expect(loads()).toEqual([{ kind: "Tourney", command: { type: "loadChat", payload: { tournamentId: "e1a2b" } } }]);

    applyEvent({
      kind: "Tourney",
      event: {
        type: "chatRoomsLoaded",
        payload: {
          rooms: [
            { id: "global", name: "Global", unread: 0, done: false, mentioned: false, needsOrganiser: false, count: 0 },
          ],
        },
      },
    });
    expect(screen.getByRole("button", { name: "Global" })).toBeDefined();

    // Away and back: the rooms are here now, so nothing is asked for again.
    await user.click(within(sections).getByRole("button", { name: "Overview" }));
    await user.click(within(sections).getByRole("button", { name: /^Chat/ }));
    expect(loads()).toHaveLength(1);
  });
});
