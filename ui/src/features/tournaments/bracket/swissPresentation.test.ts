import { describe, expect, it } from "vitest";
import { team, tourney } from "../fixtures";
import type { PickPhase } from "../../../ipc/bindings";
import { clockText, isFullBracket, pickRecord, pickSeed, swissShowsBracket } from "./swissPresentation";
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
