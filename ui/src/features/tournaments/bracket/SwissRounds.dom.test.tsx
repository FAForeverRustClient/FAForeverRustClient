// @vitest-environment happy-dom
//
// The Rounds tab for Swiss and multi-division Swiss events: division-scoped
// playoffs, compact grouped Swiss rounds without duplicated record labels,
// replay playback, streamer masking, and player-name display.

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tourney } from "../../../ipc/bindings";
import { TourneyDisplayContext, type TourneyDisplay } from "../display";
import { match, player, team, tourney } from "../fixtures";
import type { MatchActions as MatchCommands } from "../tourneyActions";
import { BracketView } from "./BracketView";
import { MatchChatContext, type MatchChatApi } from "./matchChat";

afterEach(cleanup);

function commands(over: Partial<MatchCommands> = {}): MatchCommands {
  return {
    report: vi.fn(),
    answer: vi.fn(),
    host: vi.fn(),
    reportFfa: vi.fn(),
    watchReplay: vi.fn(),
    refresh: vi.fn(),
    veto: {
      onAct: vi.fn(),
      onSetSides: vi.fn(),
      onUndo: vi.fn(),
      onFaction: vi.fn(),
    },
    ...over,
  };
}

const defaultDisplay: TourneyDisplay = {
  showPlayers: false,
  streamer: false,
  masked: () => false,
  matchupShown: () => false,
  toggleMatchup: () => undefined,
};

function renderBracket(
  event: Tourney,
  options: {
    matches?: MatchCommands;
    display?: Partial<TourneyDisplay>;
    chat?: MatchChatApi | null;
  } = {},
) {
  const display: TourneyDisplay = { ...defaultDisplay, ...options.display };
  const body = (
    <TourneyDisplayContext.Provider value={display}>
      <BracketView
        event={event}
        profiles={[]}
        busyMatchId={null}
        vault={[]}
        assetBase=""
        matches={options.matches ?? commands()}
        onAdmin={vi.fn()}
      />
    </TourneyDisplayContext.Provider>
  );
  return render(
    options.chat === undefined || options.chat === null ? (
      body
    ) : (
      <MatchChatContext.Provider value={options.chat}>{body}</MatchChatContext.Provider>
    ),
  );
}

describe("BracketView and SwissRounds, mounted", () => {
  it("scopes per-division playoffs and Swiss rounds to the selected division", async () => {
    const user = userEvent.setup();
    const event = tourney({
      name: "King and Prince",
      bracketKind: "swiss",
      teamSize: 2,
      divisions: 2,
      swissRounds: 2,
      teams: [
        team({ id: "k1", name: "Team Nory", division: 1, seed: 3 }),
        team({ id: "k2", name: "Team Popiska", division: 1, seed: 5 }),
        team({ id: "k3", name: "One-Way Ticket", division: 1, seed: 6 }),
        team({ id: "p1", name: "Team Sainse", division: 2, seed: 3 }),
        team({ id: "p2", name: "TROLLBASS TEAM", division: 2, seed: 5 }),
        team({ id: "p3", name: "Grey Ravens", division: 2, seed: 2 }),
      ],
      matches: [
        match({
          id: "k-sw1",
          bracket: "swiss",
          division: 1,
          round: 1,
          team1: "k1",
          team2: "k3",
          status: "done",
          score1: 0,
          score2: 1,
          winner: "k3",
          loser: "k1",
        }),
        match({
          id: "p-sw1",
          bracket: "swiss",
          division: 2,
          round: 1,
          team1: "p1",
          team2: "p3",
          status: "done",
          score1: 0,
          score2: 1,
          winner: "p3",
          loser: "p1",
        }),
        match({
          id: "k-po1",
          bracket: "winners",
          division: 1,
          round: 1,
          bestOf: 1,
          team1: "k1",
          team2: "k2",
          status: "done",
          score1: 1,
          score2: 0,
          winner: "k1",
          loser: "k2",
          winnerTo: { matchId: "k-gf", slot: 2 },
        }),
        match({
          id: "k-gf",
          bracket: "grandFinal",
          division: 1,
          round: 1,
          bestOf: 3,
          team1: "k3",
          team2: "k1",
          status: "ready",
        }),
        match({
          id: "p-po1",
          bracket: "winners",
          division: 2,
          round: 1,
          bestOf: 1,
          team1: "p1",
          team2: "p2",
          status: "done",
          score1: 0,
          score2: 1,
          winner: "p2",
          loser: "p1",
          winnerTo: { matchId: "p-gf", slot: 2 },
        }),
        match({
          id: "p-gf",
          bracket: "grandFinal",
          division: 2,
          round: 1,
          bestOf: 3,
          team1: "p3",
          team2: "p2",
          status: "done",
          score1: 2,
          score2: 0,
          winner: "p3",
          loser: "p2",
        }),
      ],
    });

    renderBracket(event);

    // King division is active first: only King playoffs and King Swiss appear.
    expect(screen.getByText("2 rounds · 2 matches")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Semi-final" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Grand final" })).toBeDefined();
    expect(screen.getByText("Team Popiska")).toBeDefined();
    expect(screen.queryByText("TROLLBASS TEAM")).toBeNull();
    expect(screen.queryByText("Grey Ravens")).toBeNull();

    // Switching to Prince division swaps both Playoffs and Swiss to Prince.
    await user.click(screen.getByRole("button", { name: "Prince division" }));
    expect(screen.getAllByText("TROLLBASS TEAM")).toHaveLength(2);
    expect(screen.getAllByText("Grey Ravens")).toHaveLength(2);
    expect(screen.queryByText("Team Popiska")).toBeNull();
    expect(screen.queryByText("One-Way Ticket")).toBeNull();
  });

  it("marks each Swiss score group once without duplicate dividers or chips and preserves floated records", async () => {
    const user = userEvent.setup();
    const watchReplay = vi.fn();
    const event = tourney({
      bracketKind: "swiss",
      teamSize: 1,
      swissRounds: 2,
      players: [
        player({ id: "p1", name: "Alpha", teamId: "t1" }),
        player({ id: "p2", name: "Bravo", teamId: "t2" }),
        player({ id: "p3", name: "Charlie", teamId: "t3" }),
        player({ id: "p4", name: "Delta", teamId: "t4" }),
        player({ id: "p5", name: "Echo", teamId: "t5" }),
        player({ id: "p6", name: "Foxtrot", teamId: "t6" }),
        player({ id: "p7", name: "Golf", teamId: "t7" }),
      ],
      teams: [
        team({ id: "t1", name: "Alpha", playerIds: ["p1"] }),
        team({ id: "t2", name: "Bravo", playerIds: ["p2"] }),
        team({ id: "t3", name: "Charlie", playerIds: ["p3"] }),
        team({ id: "t4", name: "Delta", playerIds: ["p4"] }),
        team({ id: "t5", name: "Echo", playerIds: ["p5"] }),
        team({ id: "t6", name: "Foxtrot", playerIds: ["p6"] }),
        team({ id: "t7", name: "Golf", playerIds: ["p7"] }),
      ],
      matches: [
        match({ id: "r1m1", bracket: "swiss", round: 1, index: 0, team1: "t1", team2: "t2", status: "done", winner: "t1", loser: "t2", score1: 1, score2: 0 }),
        match({ id: "r1m2", bracket: "swiss", round: 1, index: 1, team1: "t3", team2: "t4", status: "done", winner: "t3", loser: "t4", score1: 1, score2: 0 }),
        match({ id: "r1m3", bracket: "swiss", round: 1, index: 2, team1: "t5", team2: "t6", status: "done", winner: "t5", loser: "t6", score1: 1, score2: 0 }),
        match({ id: "r1bye", bracket: "swiss", round: 1, index: 3, team1: "t7", team2: "BYE", status: "bye" }),
        // Round 2: two 1-0 matches (t1 vs t3, t5 vs t7) -> only the first carries the 1-0 badge;
        // plus one 0-1 match (t2 vs t4) and a floated match can be tested separately, with bye for t6.
        match({ id: "r2m1", bracket: "swiss", round: 2, index: 0, team1: "t1", team2: "t3", status: "done", winner: "t1", loser: "t3", score1: 1, score2: 0, replayIds: ["12345"] }),
        match({ id: "r2m2", bracket: "swiss", round: 2, index: 1, team1: "t5", team2: "t7", status: "done", winner: "t7", loser: "t5", score1: 0, score2: 1 }),
        match({ id: "r2m3", bracket: "swiss", round: 2, index: 2, team1: "t2", team2: "t4", status: "ready" }),
        match({ id: "r2bye", bracket: "swiss", round: 2, index: 3, team1: "t6", team2: "BYE", status: "bye" }),
      ],
    });

    renderBracket(event, { matches: commands({ watchReplay }) });

    // No separate "Record 1-0" divider rows.
    expect(screen.queryByText(/Record /)).toBeNull();
    // Both 1-0 matches sit in one group, so "1-0" is printed once.
    expect(screen.getAllByText("1-0")).toHaveLength(1);
    // "0-1" appears for the 0-1 match and the 0-1 bye row.
    expect(screen.getAllByText("0-1")).toHaveLength(2);
    expect(screen.getByText("Bye")).toBeDefined();
    expect(screen.getByText("free win")).toBeDefined();

    // Finished Swiss match offers its replay directly.
    await user.click(screen.getByRole("button", { name: "Game 1: watch replay 12345 in the client" }));
    expect(watchReplay).toHaveBeenCalledWith(12345);

    // Switching to All rounds shows both Round 2 and Round 1.
    await user.click(screen.getByRole("button", { name: "All rounds" }));
    expect(screen.getByRole("heading", { name: "Round 2 / 2" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Round 1 / 2" })).toBeDefined();
  });

  it("keeps floated record labels visible even inside a lower score group", () => {
    const event = tourney({
      bracketKind: "swiss",
      teamSize: 1,
      swissRounds: 2,
      teams: [
        team({ id: "t1", name: "Alpha" }),
        team({ id: "t2", name: "Bravo" }),
        team({ id: "t3", name: "Charlie" }),
        team({ id: "t4", name: "Delta" }),
        team({ id: "t5", name: "Echo" }),
        team({ id: "t6", name: "Foxtrot" }),
      ],
      matches: [
        match({ id: "r1m1", bracket: "swiss", round: 1, index: 0, team1: "t1", team2: "t2", status: "done", winner: "t1", loser: "t2" }),
        match({ id: "r1m2", bracket: "swiss", round: 1, index: 1, team1: "t3", team2: "t4", status: "done", winner: "t3", loser: "t4" }),
        match({ id: "r1m3", bracket: "swiss", round: 1, index: 2, team1: "t5", team2: "t6", status: "done", winner: "t5", loser: "t6" }),
        // Round 2: t1 vs t3 (1-0), t5 vs t2 (floated 1-0 vs 0-1 -> filed under 0-1), t4 vs t6 (0-1).
        match({ id: "r2m1", bracket: "swiss", round: 2, index: 0, team1: "t1", team2: "t3", status: "ready" }),
        match({ id: "r2m2", bracket: "swiss", round: 2, index: 1, team1: "t5", team2: "t2", status: "ready" }),
        match({ id: "r2m3", bracket: "swiss", round: 2, index: 2, team1: "t4", team2: "t6", status: "ready" }),
      ],
    });

    renderBracket(event);

    expect(screen.getByText("1-0")).toBeDefined();
    expect(screen.getByText("1-0 vs 0-1")).toBeDefined();
    expect(screen.getByText("0-1")).toBeDefined();
  });

  it("respects streamer masking and showPlayers in Swiss rounds", () => {
    const event = tourney({
      bracketKind: "swiss",
      teamSize: 2,
      swissRounds: 1,
      players: [
        player({ id: "p1", name: "Alice", teamId: "t1" }),
        player({ id: "p2", name: "Bob", teamId: "t1" }),
        player({ id: "p3", name: "Cara", teamId: "t2" }),
        player({ id: "p4", name: "Dan", teamId: "t2" }),
      ],
      teams: [
        team({ id: "t1", name: "North", playerIds: ["p1", "p2"] }),
        team({ id: "t2", name: "South", playerIds: ["p3", "p4"] }),
      ],
      matches: [
        match({
          id: "m1",
          bracket: "swiss",
          round: 1,
          team1: "t1",
          team2: "t2",
          status: "done",
          score1: 2,
          score2: 1,
          winner: "t1",
          loser: "t2",
          replayIds: ["99001"],
        }),
      ],
    });

    renderBracket(event, {
      display: {
        showPlayers: true,
        streamer: true,
        masked: (entry) => entry.status === "done",
      },
    });

    const row = within(screen.getByRole("listitem"));
    expect(row.getByText("Alice, Bob")).toBeDefined();
    expect(row.getByText("Cara, Dan")).toBeDefined();
    expect(row.getByText("Played")).toBeDefined();
    expect(row.queryByText("2")).toBeNull();
    // Replays stay available for casters even while scores are masked.
    expect(row.getByRole("button", { name: "Game 1: watch replay 99001 in the client" })).toBeDefined();
  });
});
