// @vitest-environment happy-dom
//
// Answering the other side's result from the match list, mounted inside the
// whole tab. The answer goes out as the event's own command; the spinner sits
// on the one match the backend named in `actionStarted`, not on the rest of
// the list; a refusal is shown and the answer can be given again; and the
// reload's detail, not the click, is what settles the match on screen.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Tourney, TourneyAction, TourneyCommand } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../../testing/mounted";
import { match, player, team, tourney } from "../fixtures";
import { TournamentsView } from "../TournamentsView";

vi.mock("../../../ipc/client");

failOnConsoleError();

const claimed = { score1: 1, score2: 2, byName: "Bravo", replayIds: [], drawReplayIds: [], at: null };

/** This account plays for Alpha, and both of Alpha's opponents have reported. */
const running = tourney({
  id: "e1a2b",
  name: "Spring Cup",
  status: "running",
  viewer: { ...tourney().viewer, signedUpPlayerId: "p1", memberTeamId: "t1" },
  players: [
    player({ id: "p1", name: "Alpha", teamId: "t1" }),
    player({ id: "p2", name: "Bravo", fafId: 202, teamId: "t2" }),
    player({ id: "p3", name: "Charlie", fafId: 203, teamId: "t3" }),
  ],
  teams: [
    team({ id: "t1", name: "Alpha" }),
    team({ id: "t2", name: "Bravo", seed: 2, captainId: "p2", playerIds: ["p2"] }),
    team({ id: "t3", name: "Charlie", seed: 3, captainId: "p3", playerIds: ["p3"] }),
  ],
  matches: [
    match({ id: "m1", round: 1, team1: "t1", team2: "t2", pendingReport: { ...claimed, byTeam: "t2" } }),
    match({ id: "m2", round: 2, index: 0, team1: "t1", team2: "t3", pendingReport: { ...claimed, byTeam: "t3", byName: "Charlie" } }),
  ],
});

function mountTab(event: Tourney) {
  seedStore((state) => ({
    ...state,
    tourney: { ...state.tourney, status: { type: "ready" }, events: [event], selectedId: event.id, detail: event },
  }));
  return render(<TournamentsView />);
}

async function openMatch(user: ReturnType<typeof userEvent.setup>, row: number) {
  const sections = screen.getByRole("navigation", { name: "Tournament sections" });
  await user.click(within(sections).getByRole("button", { name: /^Matches/ }));
  await user.click(screen.getAllByRole("button", { name: "Details" })[row]);
  return screen.getByRole("dialog");
}

function answers(): TourneyCommand[] {
  return sentCommands().flatMap((command) =>
    command.kind === "Tourney" && command.command.type === "answerReport" ? [command.command] : [],
  );
}

function started(action: TourneyAction) {
  applyEvent({ kind: "Tourney", event: { type: "actionStarted", payload: { action } } });
}

describe("MatchesPanel answering a reported result, mounted", () => {
  it("confirms through the event's command and waits for the service before the match changes", async () => {
    const user = userEvent.setup();
    mountTab(running);
    const dialog = await openMatch(user, 0);

    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(answers()).toEqual([
      { type: "answerReport", payload: { tournamentId: "e1a2b", matchId: "m1", accept: true } },
    ]);
    // Nothing assumed: the answer is still owed until the reload says otherwise.
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDefined();

    const action: TourneyAction = { type: "answeringReport", payload: { matchId: "m1" } };
    started(action);
    expect(within(dialog).getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(true);

    applyEvent({ kind: "Tourney", event: { type: "actionSucceeded", payload: { action, select: null } } });
    applyEvent({
      kind: "Tourney",
      event: {
        type: "detailLoaded",
        payload: {
          event: {
            ...running,
            matches: running.matches.map((entry) =>
              entry.id === "m1"
                ? { ...entry, status: "done", score1: 1, score2: 2, winner: "t2", loser: "t1", pendingReport: null }
                : entry,
            ),
          },
        },
      },
    });
    expect(within(dialog).queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("puts the spinner on the match being answered only, and gives the controls back on a refusal", async () => {
    const user = userEvent.setup();
    mountTab(running);

    // The answer for the first match is in flight while the second is opened.
    started({ type: "answeringReport", payload: { matchId: "m1" } });
    const second = await openMatch(user, 1);
    const reject = within(second).getByRole("button", { name: "Reject" });
    expect(reject.hasAttribute("disabled")).toBe(false);

    await user.click(reject);
    expect(answers()).toEqual([
      { type: "answerReport", payload: { tournamentId: "e1a2b", matchId: "m2", accept: false } },
    ]);
    const action: TourneyAction = { type: "answeringReport", payload: { matchId: "m2" } };
    started(action);
    expect(reject.hasAttribute("disabled")).toBe(true);

    applyEvent({
      kind: "Tourney",
      event: {
        type: "actionFailed",
        payload: { failure: { action, reason: "The report was already confirmed by an organiser", kind: "rejected" } },
      },
    });
    expect(screen.getByText("The report was already confirmed by an organiser")).toBeDefined();
    expect(reject.hasAttribute("disabled")).toBe(false);
    expect(within(second).getByRole("button", { name: "Confirm" }).hasAttribute("disabled")).toBe(false);
  });

  it("lets the dialog close while the answer is in flight and takes the late answer without complaint", async () => {
    const user = userEvent.setup();
    mountTab(running);
    const dialog = await openMatch(user, 0);

    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    const action: TourneyAction = { type: "answeringReport", payload: { matchId: "m1" } };
    started(action);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    // The service answers after the dialog went: the list redraws, nothing
    // reopens, and the console stays quiet (checked after the test).
    applyEvent({
      kind: "Tourney",
      event: {
        type: "actionFailed",
        payload: { failure: { action, reason: "Match already decided", kind: "rejected" } },
      },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Match already decided")).toBeDefined();
  });
});
