// @vitest-environment happy-dom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tourney } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { player, team, tourney } from "./fixtures";
import { TournamentEventDetail } from "./TournamentEventDetail";

vi.mock("../../ipc/client");
failOnConsoleError();

function draft(): Tourney {
  return tourney({
    status: "draft",
    formation: "draft",
    teamSize: 2,
    players: [
      player({ id: "p1", name: "Ada", teamId: "t1" }),
      player({ id: "p2", name: "Bob", teamId: "t2" }),
      player({ id: "p3", name: "Cid", teamId: null }),
      player({ id: "p4", name: "Dee", teamId: null }),
    ],
    teams: [
      team({ id: "t1", name: "Alpha", captainId: "p1", playerIds: ["p1"] }),
      team({ id: "t2", name: "Bravo", captainId: "p2", playerIds: ["p2"] }),
    ],
    draft: { order: ["t1", "t2"], current: 0, lastPick: null },
  });
}

function mount(event = draft(), inGame = false) {
  seedStore((state) => ({
    ...state,
    lobby: inGame ? { ...state.lobby, join: { type: "inGame" } } : state.lobby,
    tourney: { ...state.tourney, events: [event], selectedId: event.id, detail: event },
  }));
  return render(<TournamentEventDetail jump={null} onOpenPage={() => undefined} onSignUp={() => undefined} onReport={() => undefined} />);
}

const refreshes = () => sentCommands().filter((command) => command.kind === "Tourney" && command.command.type === "refreshDetail");

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the open captains' draft", () => {
  it("refreshes every five seconds and updates teams and the pool without leaving Teams", async () => {
    const event = draft();
    mount(event);
    expect(refreshes()).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Tournament sections" })).getByRole("button", { name: "Teams" }));
    expect(screen.getByText("Alpha is on the clock")).toBeDefined();
    expect(within(screen.getByRole("table")).getByRole("button", { name: "Cid" })).toBeDefined();
    clearSentCommands();

    await advance(4_999);
    expect(refreshes()).toHaveLength(0);
    await advance(1);
    expect(refreshes()).toEqual([{ kind: "Tourney", command: { type: "refreshDetail", payload: { tournamentId: event.id } } }]);
    applyEvent({ kind: "Tourney", event: { type: "detailLoaded", payload: { event: {
      ...event,
      players: event.players.map((held) => held.id === "p3" ? { ...held, teamId: "t1" } : held),
      teams: event.teams.map((held) => held.id === "t1" ? { ...held, playerIds: [...held.playerIds, "p3"] } : held),
      draft: { ...event.draft!, current: 1 },
    } } } });
    expect(screen.getByRole("button", { name: "Teams", current: true })).toBeDefined();
    expect(screen.getByText("Bravo is on the clock")).toBeDefined();
    expect(within(screen.getByRole("table")).queryByRole("button", { name: "Cid" })).toBeNull();
    expect(within(screen.getByText("Alpha").closest("li")!).getByRole("button", { name: "Cid" })).toBeDefined();
    await advance(5_000);
    expect(refreshes()).toHaveLength(2);
  });

  it("waits for a slow refresh to finish and retries after a failed request", async () => {
    let rejectRead!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectRead = reject; });
    const settle = vi.spyOn(ipc, "settle").mockImplementationOnce(() => pending);
    mount();
    await advance(20_000);
    expect(settle).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectRead(new Error("offline"));
      await pending.catch(() => undefined);
    });
    await advance(5_000);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("stops when the draft finishes and when the view unmounts", async () => {
    const event = draft();
    const view = mount(event);
    await advance(0);
    clearSentCommands();
    applyEvent({ kind: "Tourney", event: { type: "detailLoaded", payload: { event: { ...event, status: "drafted" } } } });
    await advance(15_000);
    expect(refreshes()).toHaveLength(0);

    applyEvent({ kind: "Tourney", event: { type: "detailLoaded", payload: { event } } });
    expect(refreshes()).toHaveLength(1);
    view.unmount();
    await advance(15_000);
    expect(refreshes()).toHaveLength(1);
  });

  it("pauses while hidden and refreshes the current event after returning", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mount();
    await advance(0);
    clearSentCommands();
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await advance(15_000);
    expect(refreshes()).toHaveLength(0);

    const other = { ...draft(), id: "another" };
    applyEvent({ kind: "Tourney", event: { type: "selected", payload: { tournamentId: other.id } } });
    applyEvent({ kind: "Tourney", event: { type: "detailLoaded", payload: { event: other } } });
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(refreshes()).toEqual([{ kind: "Tourney", command: { type: "refreshDetail", payload: { tournamentId: other.id } } }]);
  });

  it("keeps a visible draft current while a game runs", async () => {
    mount(draft(), true);
    clearSentCommands();
    await advance(5_000);
    expect(refreshes()).toHaveLength(1);
  });

  it("does not poll tournaments that are outside the draft", async () => {
    mount(tourney({ status: "signup" }));
    await advance(15_000);
    expect(refreshes()).toHaveLength(0);
  });
});
