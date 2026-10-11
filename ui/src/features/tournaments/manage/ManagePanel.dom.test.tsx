// @vitest-environment happy-dom
//
// The organiser's writes, mounted inside the whole tab so the busy state and
// the refusal banner are the ones the organiser actually sees. Each write
// follows the backend's three answers in turn: `actionStarted` disables the
// controls, `actionFailed` puts the service's own sentence on screen and gives
// the controls back, and on success the reload's detail replaces what was
// drawn. Nothing is assumed in between: a click changes nothing on screen
// until the backend says so.

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

const organiser = { ...tourney().viewer, organiser: true };

/** An event taking signups: one entrant in, one waiting for approval. */
const signups = tourney({
  id: "e1a2b",
  name: "Spring Cup",
  status: "signup",
  viewer: organiser,
  playerCount: 2,
  players: [
    player({ id: "p1", name: "Alpha", fafId: 201, teamId: null }),
    player({ id: "p2", name: "Bravo", fafId: 202, teamId: null, pending: true }),
  ],
});

/** A running bracket with two rounds and two pools to bind them to. */
const running = tourney({
  id: "e1a2b",
  name: "Spring Cup",
  status: "running",
  viewer: organiser,
  teams: [team({ id: "t1", name: "Alpha" }), team({ id: "t2", name: "Bravo", seed: 2, captainId: "p2", playerIds: ["p2"] })],
  matches: [match({ id: "m1", round: 1 }), match({ id: "m2", round: 2, team1: null, team2: null, status: "waiting" })],
  mapPools: [
    { id: "pool-a", name: "Pool A", mapIds: [], sequence: [], bestOf: null, published: true, publishAt: null },
    { id: "pool-b", name: "Pool B", mapIds: [], sequence: [], bestOf: null, published: true, publishAt: null },
  ],
});

function mountTab(event: Tourney) {
  seedStore((state) => ({
    ...state,
    tourney: {
      ...state.tourney,
      status: { type: "ready" },
      events: [event],
      selectedId: event.id,
      detail: event,
      // Loaded already, so opening Manage does not ask for it and the
      // commands a test reads are its own.
      series: [{ id: "s1", name: "Spring Series", description: "", colour: "plain", category: null, editions: 1, active: 1, lastAt: null, latestId: null, latestName: "", latestDate: null }],
    },
  }));
  return render(<TournamentsView />);
}

async function openManage(user: ReturnType<typeof userEvent.setup>) {
  const sections = screen.getByRole("navigation", { name: "Tournament sections" });
  await user.click(within(sections).getByRole("button", { name: "Manage" }));
}

/** The tourney commands of one type sent so far. */
function sent<T extends TourneyCommand["type"]>(type: T): Extract<TourneyCommand, { type: T }>[] {
  return sentCommands().flatMap((command) =>
    command.kind === "Tourney" && command.command.type === type
      ? [command.command as Extract<TourneyCommand, { type: T }>]
      : [],
  );
}

function started(action: TourneyAction) {
  applyEvent({ kind: "Tourney", event: { type: "actionStarted", payload: { action } } });
}

function failed(action: TourneyAction, reason: string) {
  applyEvent({
    kind: "Tourney",
    event: { type: "actionFailed", payload: { failure: { action, reason, kind: "rejected" } } },
  });
}

function succeeded(action: TourneyAction, detail: Tourney) {
  applyEvent({ kind: "Tourney", event: { type: "actionSucceeded", payload: { action, select: null } } });
  applyEvent({ kind: "Tourney", event: { type: "detailLoaded", payload: { event: detail } } });
}

describe("ManagePanel organiser writes, mounted", () => {
  it("advances the phase, waits while it runs, shows a refusal and takes the retry's reload", async () => {
    const user = userEvent.setup();
    mountTab(signups);
    await openManage(user);

    const formTeams = screen.getByRole("button", { name: "Close signups and form teams" });
    await user.click(formTeams);
    expect(sent("advance")).toEqual([
      { type: "advance", payload: { tournamentId: "e1a2b", phase: "formTeams", config: null } },
    ]);
    // Still the signup stage until the service answers.
    expect(formTeams.hasAttribute("disabled")).toBe(false);

    const action: TourneyAction = { type: "advancing", payload: { phase: "formTeams" } };
    started(action);
    expect(formTeams.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Mark as abandoned" }).hasAttribute("disabled")).toBe(true);

    failed(action, "Need at least two entrants to form teams");
    expect(screen.getByText("Need at least two entrants to form teams")).toBeDefined();
    expect(formTeams.hasAttribute("disabled")).toBe(false);

    // The retry: starting it takes the old refusal down, and the reload's
    // detail moves the lifecycle on.
    await user.click(formTeams);
    expect(sent("advance")).toHaveLength(2);
    started(action);
    expect(screen.queryByText("Need at least two entrants to form teams")).toBeNull();
    succeeded(action, { ...signups, status: "drafted", teamCount: 2 });
    expect(screen.queryByRole("button", { name: "Close signups and form teams" })).toBeNull();
    expect(screen.getByRole("button", { name: "Draw the bracket" }).hasAttribute("disabled")).toBe(false);
  });

  it("approves a waiting signup, keeps the row until the reload, and lists the player once it lands", async () => {
    const user = userEvent.setup();
    mountTab(signups);
    await openManage(user);
    await user.click(screen.getByRole("button", { name: /^Players.*entered/ }));

    const approve = screen.getByRole("button", { name: "Approve" });
    await user.click(approve);
    expect(sent("respondSignup")).toEqual([
      { type: "respondSignup", payload: { tournamentId: "e1a2b", playerId: "p2", accept: true } },
    ]);

    const action: TourneyAction = { type: "answeringSignup", payload: { playerId: "p2" } };
    started(action);
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Decline" }).hasAttribute("disabled")).toBe(true);

    failed(action, "This player is banned from the event");
    expect(screen.getByText("This player is banned from the event")).toBeDefined();
    // The row is still waiting and still answerable.
    expect(approve.hasAttribute("disabled")).toBe(false);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);

    await user.click(approve);
    started(action);
    succeeded(action, {
      ...signups,
      players: signups.players.map((entry) => ({ ...entry, pending: false })),
    });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  });

  it("binds a pool to a round, disables the tags while it runs, and marks the tag once the reload says so", async () => {
    const user = userEvent.setup();
    mountTab(running);
    await openManage(user);
    await user.click(screen.getByRole("button", { name: /^Map pools/ }));

    // The first round's own tags, not the "every round" shortcut above them.
    const rounds = screen.getAllByRole("button", { name: "Pool A", pressed: false });
    expect(rounds).toHaveLength(2);
    await user.click(rounds[0]);
    const [assign] = sent("assignPool");
    expect(assign).toEqual({
      type: "assignPool",
      payload: { tournamentId: "e1a2b", roundKey: expect.any(String) as unknown, poolId: "pool-a" },
    });
    const roundKey = assign.payload.roundKey;

    const action: TourneyAction = { type: "assigningPool", payload: { roundKey } };
    started(action);
    for (const tag of screen.getAllByRole("button", { name: /^Pool [AB]$/ })) {
      expect(tag.hasAttribute("disabled")).toBe(true);
    }

    failed(action, "Pool A has no maps yet");
    expect(screen.getByText("Pool A has no maps yet")).toBeDefined();
    expect(screen.queryAllByRole("button", { name: "Pool A", pressed: true })).toHaveLength(0);
    expect(rounds[0].hasAttribute("disabled")).toBe(false);

    await user.click(rounds[0]);
    started(action);
    succeeded(action, { ...running, poolAssign: [{ round: roundKey, poolId: "pool-a" }] });
    expect(screen.getAllByRole("button", { name: "Pool A", pressed: true })).toHaveLength(1);
    // Clicking the bound tag clears the round again.
    await user.click(screen.getByRole("button", { name: "Pool A", pressed: true }));
    const assigns = sent("assignPool");
    expect(assigns[assigns.length - 1]).toEqual({
      type: "assignPool",
      payload: { tournamentId: "e1a2b", roundKey, poolId: "" },
    });
  });

  it("files the event under a series only once the reload carries it, and keeps the old choice on a refusal", async () => {
    const user = userEvent.setup();
    mountTab(signups);
    await openManage(user);
    await user.click(screen.getByRole("button", { name: /^Series and qualifiers/ }));

    const picker = screen.getByRole("combobox", { name: "This event belongs to" });
    expect((picker as HTMLSelectElement).value).toBe("");
    await user.selectOptions(picker, "s1");
    expect(sent("setSeries")).toEqual([
      { type: "setSeries", payload: { tournamentId: "e1a2b", seriesId: "s1" } },
    ]);
    // The select shows what the event says, not what was picked.
    expect((picker as HTMLSelectElement).value).toBe("");

    const action: TourneyAction = { type: "settingSeries" };
    started(action);
    expect(picker.hasAttribute("disabled")).toBe(true);
    failed(action, "Only the series owner can add editions");
    expect(screen.getByText("Only the series owner can add editions")).toBeDefined();
    expect(picker.hasAttribute("disabled")).toBe(false);
    expect((picker as HTMLSelectElement).value).toBe("");

    await user.selectOptions(picker, "s1");
    started(action);
    succeeded(action, { ...signups, seriesId: "s1", seriesName: "Spring Series" });
    expect((picker as HTMLSelectElement).value).toBe("s1");
    expect(screen.queryByText("Only the series owner can add editions")).toBeNull();
  });

  it("sends a second advance on a double click: the tab does not guard a write before the service starts it", async () => {
    const user = userEvent.setup();
    mountTab(signups);
    await openManage(user);

    // Documented rather than wished away: the buttons disable on the
    // backend's `actionStarted`, and the tourney writes are serial in the
    // command policy, so the second click queues behind the first instead of
    // racing it. Once the first has started, nothing more gets through.
    await user.dblClick(screen.getByRole("button", { name: "Close signups and form teams" }));
    expect(sent("advance")).toHaveLength(2);

    started({ type: "advancing", payload: { phase: "formTeams" } });
    await user.click(screen.getByRole("button", { name: "Close signups and form teams" }));
    expect(sent("advance")).toHaveLength(2);
  });
});
