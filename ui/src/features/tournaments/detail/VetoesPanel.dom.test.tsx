// @vitest-environment happy-dom
//
// A captain's map ban from the Vetoes section, mounted inside the whole tab.
// A ban is two clicks by design, arm and confirm, so a double click is one
// step and never two; the run waits on the backend's `actionStarted` for that
// match; a refusal leaves the map in play and the grid usable; and the
// reload's run, not the click, is what moves the turn on.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MatchVeto, TourneyAction, TourneyCommand, TourneyMap } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../../testing/mounted";
import { match, player, team, tourney } from "../fixtures";
import { TournamentsView } from "../TournamentsView";

vi.mock("../../../ipc/client");

failOnConsoleError();

function map(id: string, name: string): TourneyMap {
  return { id, name, imageUrl: "", description: "", published: true, spec: null, secret: false, masked: false };
}

const run: MatchVeto = {
  remaining: ["arctic", "canis", "dual"],
  banned: [],
  picks: [],
  sequence: [
    { action: "ban", team: "a" },
    { action: "ban", team: "b" },
  ],
  stepIndex: 0,
  teamA: "t1",
  teamB: "t2",
  done: false,
  decider: null,
};

/** This account captains Alpha, which is team A and bans first. */
const vetoing = tourney({
  id: "e1a2b",
  name: "Spring Cup",
  status: "running",
  veto: { enabled: true, mode: "upfront", teamA: "lowerA", revealBans: false },
  viewer: { ...tourney().viewer, signedUpPlayerId: "p1", memberTeamId: "t1" },
  players: [player({ id: "p1", name: "Alpha", teamId: "t1" }), player({ id: "p2", name: "Bravo", fafId: 202, teamId: "t2" })],
  teams: [team({ id: "t1", name: "Alpha" }), team({ id: "t2", name: "Bravo", seed: 2, captainId: "p2", playerIds: ["p2"] })],
  mapDb: [map("arctic", "Arctic Refuge"), map("canis", "Canis River"), map("dual", "Dual Gap")],
  matches: [match({ id: "m1", veto: run })],
});

function mountVetoes() {
  seedStore((state) => ({
    ...state,
    tourney: { ...state.tourney, status: { type: "ready" }, events: [vetoing], selectedId: vetoing.id, detail: vetoing },
  }));
  render(<TournamentsView />);
  return userEvent.setup();
}

async function openVetoes(user: ReturnType<typeof userEvent.setup>) {
  const sections = screen.getByRole("navigation", { name: "Tournament sections" });
  await user.click(within(sections).getByRole("button", { name: /^Vetoes/ }));
}

function vetoes(): TourneyCommand[] {
  return sentCommands().flatMap((command) =>
    command.kind === "Tourney" && command.command.type === "vetoAct" ? [command.command] : [],
  );
}

const action: TourneyAction = { type: "vetoing", payload: { matchId: "m1" } };

function started() {
  applyEvent({ kind: "Tourney", event: { type: "actionStarted", payload: { action } } });
}

describe("VetoesPanel map ban, mounted", () => {
  it("takes a double click as one ban, then follows the reload to the other side's turn", async () => {
    const user = mountVetoes();
    await openVetoes(user);
    expect(screen.getByText("Your turn.")).toBeDefined();

    await user.dblClick(screen.getByRole("button", { name: "Arctic Refuge" }));
    expect(vetoes()).toEqual([
      { type: "vetoAct", payload: { tournamentId: "e1a2b", matchId: "m1", mapId: "arctic" } },
    ]);

    started();
    for (const name of ["Arctic Refuge", "Canis River", "Dual Gap"]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }

    applyEvent({ kind: "Tourney", event: { type: "actionSucceeded", payload: { action, select: null } } });
    applyEvent({
      kind: "Tourney",
      event: {
        type: "detailLoaded",
        payload: {
          event: {
            ...vetoing,
            matches: [
              match({
                id: "m1",
                veto: { ...run, remaining: ["canis", "dual"], banned: [{ map: "arctic", by: "t1", game: null }], stepIndex: 1 },
              }),
            ],
          },
        },
      },
    });
    // Bravo's turn now: nothing left to click here, and the ban is on record.
    expect(screen.queryByText("Your turn.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Canis River" })).toBeNull();
    const banned = screen.getByRole("heading", { name: "Banned" }).parentElement;
    expect(banned).not.toBeNull();
    expect(within(banned as HTMLElement).getByText("Arctic Refuge")).toBeDefined();
  });

  it("leaves the map in play and the grid usable when the service refuses the ban", async () => {
    const user = mountVetoes();
    await openVetoes(user);

    const arctic = screen.getByRole("button", { name: "Arctic Refuge" });
    await user.click(arctic);
    // Armed, not sent: the first click only asks for the second.
    expect(vetoes()).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Arctic Refuge.*Click again to ban/ })).toBe(arctic);
    await user.click(arctic);
    expect(vetoes()).toHaveLength(1);

    started();
    applyEvent({
      kind: "Tourney",
      event: {
        type: "actionFailed",
        payload: { failure: { action, reason: "It is not your turn to ban", kind: "rejected" } },
      },
    });
    expect(screen.getByText("It is not your turn to ban")).toBeDefined();
    expect(screen.getByText("Your turn.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Arctic Refuge" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Canis River" }).hasAttribute("disabled")).toBe(false);
  });
});
