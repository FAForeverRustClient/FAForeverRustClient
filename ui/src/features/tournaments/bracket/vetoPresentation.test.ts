// The veto panel's reading rules, taken from the website. Presentation only,
// so no conformance twin: the service decides every turn, and what is pinned
// here is the order the run is shown in and how many steps a player owes.

import { describe, expect, it } from "vitest";
import type { MatchVeto } from "../../../ipc/bindings";
import { match, team, tourney } from "../fixtures";
import { myVetoSteps, vetoLog, vetoSettled } from "./vetoPresentation";

const run = (over: Partial<MatchVeto> = {}): MatchVeto => ({
  remaining: ["m4", "m5"],
  banned: [
    { map: "m1", by: "t1", game: null },
    { map: "m3", by: "t2", game: null },
  ],
  picks: [{ map: "m2", by: "t2", game: 1 }],
  sequence: [
    { action: "ban", team: "a" },
    { action: "pick", team: "b" },
    { action: "ban", team: "b" },
    { action: "pick", team: "a" },
  ],
  stepIndex: 3,
  teamA: "t1",
  teamB: "t2",
  done: false,
  decider: null,
  ...over,
});

describe("vetoLog", () => {
  it("interleaves the bans and picks in the order they were walked", () => {
    expect(vetoLog(run()).map((step) => `${step.kind}:${step.map}`)).toEqual([
      "ban:m1",
      "pick:m2",
      "ban:m3",
    ]);
  });

  it("keeps a choice the sequence does not account for", () => {
    const log = vetoLog(run({ stepIndex: 1 }));
    expect(log.map((step) => step.map)).toEqual(["m1", "m3", "m2"]);
  });
});

describe("myVetoSteps", () => {
  const event = tourney({
    teamSize: 1,
    veto: { enabled: true, mode: "upfront", teamA: "lowerA", revealBans: false },
    factionVeto: { enabled: true, bans: 1, picks: 2 },
    teams: [team({ id: "t1", captainId: "p1" }), team({ id: "t2", captainId: "p2" })],
    viewer: { ...tourney().viewer, signedUpPlayerId: "p1", memberTeamId: "t1" },
  });

  it("counts the map step that is due and every game still owed its factions", () => {
    const entry = match({
      veto: run(),
      factionVeto: {
        bans: 1,
        picks: 2,
        games: [
          { game: 1, team1Done: false, team2Done: true, result: null, mine: { bans: [], picks: [], done: false }, next: { action: "ban", index: 1, of: 1 } },
          { game: 2, team1Done: true, team2Done: true, result: { team1: "uef", team2: "aeon" }, mine: { bans: ["cybran"], picks: ["uef", "aeon"], done: true }, next: null },
        ],
      },
    });
    // Step 4 is a pick for A, which is t1, captained by this account.
    expect(myVetoSteps(event, entry)).toBe(2);
  });

  it("owes nothing once the match has a result", () => {
    expect(myVetoSteps(event, match({ veto: run(), status: "done" }))).toBe(0);
  });
});

describe("vetoSettled", () => {
  const event = tourney({
    teamSize: 1,
    veto: { enabled: true, mode: "upfront", teamA: "lowerA", revealBans: false },
    factionVeto: { enabled: true, bans: 1, picks: 2 },
  });
  const factions = (result: boolean) => ({
    bans: 1,
    picks: 2,
    games: [
      {
        game: 1,
        team1Done: result,
        team2Done: result,
        result: result ? { team1: "uef" as const, team2: "aeon" as const } : null,
        mine: null,
        next: null,
      },
    ],
  });

  it("waits for the faction choices when the map run is over", () => {
    expect(vetoSettled(event, match({ veto: run({ done: true }), factionVeto: factions(false) }))).toBe(false);
    expect(vetoSettled(event, match({ veto: run({ done: true }), factionVeto: factions(true) }))).toBe(true);
  });

  it("reads a single run on its own", () => {
    expect(vetoSettled(event, match({ veto: run({ done: false }) }))).toBe(false);
    expect(vetoSettled(event, match({ veto: run({ done: true }) }))).toBe(true);
    expect(vetoSettled(event, match({ factionVeto: factions(true) }))).toBe(true);
    expect(vetoSettled(event, match({ status: "done", veto: run({ done: false }) }))).toBe(true);
  });
});
