import { describe, expect, it } from "vitest";
import { match, team, tourney } from "../fixtures";
import type { PickPhase } from "../../../ipc/bindings";
import {
  clockText,
  isFullBracket,
  pickRecord,
  pickSeed,
  swissDivisionEvent,
  swissDivisions,
  swissShowsBracket,
} from "./swissPresentation";
import { openingPairs, pairingProblems } from "./RoundOneEditor";

const phase = (over: Partial<PickPhase> = {}): PickPhase => ({
  open: true,
  half: 2,
  field: ["t1", "t2", "t3", "t4"],
  order: ["t1", "t2"],
  picks: [],
  available: ["t3", "t4"],
  turn: "t1",
  myTurn: false,
  secondsLeft: null,
  secondsPerPick: null,
  log: [],
  stageTwo: true,
  unbeaten: false,
  restSeeded: false,
  pool: [],
  poolBottom: false,
  records: [{ teamId: "t1", record: "3-0" }],
  drawn: [],
  ...over,
});

describe("pick phase words", () => {
  it("numbers seeds from the field and reads records", () => {
    expect(pickSeed(phase(), "t3")).toBe(3);
    expect(pickSeed(phase(), "t9")).toBeNull();
    expect(pickRecord(phase(), "t1")).toBe("3-0");
    expect(pickRecord(phase(), "t2")).toBeNull();
  });

  it("writes a clock as minutes and seconds", () => {
    expect(clockText(0)).toBe("0:00");
    expect(clockText(95)).toBe("1:35");
  });

  it("knows a full bracket when it sees one", () => {
    expect([2, 4, 6, 8, 16, 32].map(isFullBracket)).toEqual([false, true, false, true, true, true]);
  });

  it("calls a Swiss section the bracket once its playoffs exist", () => {
    const base = tourney({ bracketKind: "swiss" });
    expect(swissShowsBracket(base)).toBe(false);
    const playoffs = { pick: null, made: true, built: false, locked: false, swissDone: true, redraws: 0, double: false, cutTo: 8, field: [], thirdPlace: false };
    expect(swissShowsBracket({ ...base, playoffs })).toBe(true);
  });
});

describe("round 1 by hand", () => {
  const event = tourney({
    status: "drafted",
    teams: [team({ id: "a", seed: 1 }), team({ id: "b", seed: 2 }), team({ id: "c", seed: 3 })],
  });

  it("opens on 1 against 2 by seed, the odd one out having the bye", () => {
    expect(openingPairs(event)).toEqual([["a", "b"]]);
  });

  it("keeps a pinned plan that still fits the field", () => {
    expect(openingPairs({ ...event, plannedRoundOne: [["a", "c"]] })).toEqual([["a", "c"]]);
    expect(openingPairs({ ...event, plannedRoundOne: [["a", "x"]] })).toEqual([["a", "b"]]);
  });

  it("names who appears twice and who is left out", () => {
    expect(pairingProblems(event, [["a", "b"], ["a", "c"]])).toEqual({ twice: ["a"], missing: [] });
    const even = { ...event, teams: [...event.teams, team({ id: "d", seed: 4 })] };
    expect(pairingProblems(even, [["a", "b"]]).missing).toEqual(["c", "d"]);
  });
});

describe("a Swiss in divisions (#773)", () => {
  const event = tourney({
    bracketKind: "swiss",
    competition: "team",
    divisions: 2,
    teams: [
      team({ id: "k1", division: 1, seed: 1 }),
      team({ id: "k2", division: 1, seed: 2 }),
      team({ id: "p1", division: 2, seed: 1 }),
      team({ id: "p2", division: 2, seed: 2 }),
    ],
    matches: [
      match({ id: "k-r1", bracket: "swiss", division: 1, team1: "k1", team2: "k2", status: "done", winner: "k2", loser: "k1", score1: 0, score2: 2 }),
      match({ id: "p-r1", bracket: "swiss", division: 2, team1: "p1", team2: "p2", status: "done", winner: "p1", loser: "p2", score1: 2, score2: 1 }),
      match({ id: "p-gf", bracket: "grandFinal", division: 2, team1: "p1", team2: "p2", status: "done", winner: "p2", loser: "p1" }),
    ],
  });

  it("is only a Swiss between teams with two or more divisions", () => {
    expect(swissDivisions(event)).toEqual([1, 2]);
    expect(swissDivisions({ ...event, divisions: 0 })).toEqual([]);
    expect(swissDivisions({ ...event, bracketKind: "single" })).toEqual([]);
    expect(swissDivisions({ ...event, competition: "freeForAll" })).toEqual([]);
  });

  it("keeps each division's teams and matches to itself", () => {
    const prince = swissDivisionEvent(event, 2);
    expect(prince.teams.map((held) => held.id)).toEqual(["p1", "p2"]);
    expect(prince.matches.map((held) => held.id)).toEqual(["p-r1", "p-gf"]);
  });

  it("crowns a division by its own final", () => {
    expect(swissDivisionEvent(event, 2).championTeamId).toBe("p2");
    // The King division has no final in this event and is not over yet.
    expect(swissDivisionEvent(event, 1).championTeamId).toBeNull();
  });

  it("crowns a division without a final by its table once the event is over", () => {
    const finished = { ...event, status: "finished" as const, championTeamId: null, matches: event.matches.slice(0, 2) };
    expect(swissDivisionEvent(finished, 1).championTeamId).toBe("k2");
    expect(swissDivisionEvent(finished, 2).championTeamId).toBe("p1");
  });
});
