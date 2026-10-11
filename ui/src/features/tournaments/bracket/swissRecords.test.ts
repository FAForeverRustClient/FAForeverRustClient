// The Swiss round list's reading rules, taken from the website. Presentation
// only, so no conformance twin; what is pinned is the pair of things that make
// a round explain itself: the record each side brought in, and the order.

import { describe, expect, it } from "vitest";
import { match, team, tourney } from "../fixtures";
import {
  plannedSwissRounds,
  swissGroupOf,
  swissMatchRecord,
  swissRecordsBefore,
  swissRoundOrder,
} from "./swissRecords";

const sw = (id: string, round: number, over: Parameters<typeof match>[0] = {}) =>
  match({ id, bracket: "swiss", round, ...over });

// Round 1: t1 beats t2, t3 beats t4, t5 has the bye.
const roundOne = [
  sw("a", 1, { team1: "t1", team2: "t2", status: "done", winner: "t1", loser: "t2" }),
  sw("b", 1, { team1: "t3", team2: "t4", status: "done", winner: "t3", loser: "t4" }),
  sw("bye", 1, { team1: "t5", team2: "BYE", status: "bye", index: 99 }),
];

describe("swissRecordsBefore", () => {
  it("counts only earlier rounds, and a bye as a win", () => {
    const records = swissRecordsBefore(
      [...roundOne, sw("c", 2, { team1: "t1", team2: "t3", status: "done", winner: "t1", loser: "t3" })],
      2,
    );
    expect(records.get("t1")).toEqual({ wins: 1, losses: 0 });
    expect(records.get("t2")).toEqual({ wins: 0, losses: 1 });
    expect(records.get("t5")).toEqual({ wins: 1, losses: 0 });
    expect(records.has("BYE")).toBe(false);
  });

  it("ignores a match that has not finished", () => {
    const records = swissRecordsBefore([sw("a", 1, { team1: "t1", team2: "t2" })], 2);
    expect(records.get("t1")).toBeUndefined();
  });
});

describe("swissMatchRecord", () => {
  const records = swissRecordsBefore(roundOne, 2);

  it("shows one record for a pairing inside its group", () => {
    expect(swissMatchRecord(sw("c", 2, { team1: "t1", team2: "t3" }), records)).toBe("1-0");
  });

  it("shows both for a pairing that floated a team down", () => {
    expect(swissMatchRecord(sw("d", 2, { team1: "t5", team2: "t2" }), records)).toBe("1-0 vs 0-1");
  });

  it("shows nothing in round 1 and on a bye", () => {
    expect(swissMatchRecord(roundOne[0], new Map())).toBeNull();
    expect(swissMatchRecord(sw("e", 2, { team1: "t4", team2: "BYE", status: "bye" }), records)).toBeNull();
  });
});

describe("swissRoundOrder", () => {
  it("lists the best group first and a floated pairing with the lower group", () => {
    const records = swissRecordsBefore(roundOne, 2);
    const low = sw("low", 2, { team1: "t2", team2: "t4", index: 0 });
    const floated = sw("float", 2, { team1: "t5", team2: "t6", index: 1 });
    const top = sw("top", 2, { team1: "t1", team2: "t3", index: 2 });
    expect(swissRoundOrder([low, floated, top], records).map((entry) => entry.id)).toEqual([
      "top",
      "float",
      "low",
    ]);
  });
});

describe("swissGroupOf", () => {
  it("files a floated pairing under the lower group", () => {
    const records = swissRecordsBefore(roundOne, 2);
    expect(swissGroupOf(sw("c", 2, { team1: "t1", team2: "t3" }), records)).toBe("1-0");
    expect(swissGroupOf(sw("d", 2, { team1: "t5", team2: "t2" }), records)).toBe("0-1");
  });
});

describe("plannedSwissRounds", () => {
  const teams = Array.from({ length: 16 }, (_, index) => team({ id: `t${index}` }));

  it("takes the record cuts first", () => {
    expect(
      plannedSwissRounds(tourney({ teams, swissRounds: 7, swissCuts: { wins: 3, losses: 3 } })),
    ).toBe(5);
  });

  it("then the draw's own count, then the size of the field", () => {
    expect(plannedSwissRounds(tourney({ teams, swissRounds: 7 }))).toBe(7);
    expect(plannedSwissRounds(tourney({ teams, swissRounds: 0 }))).toBe(4);
  });
});
