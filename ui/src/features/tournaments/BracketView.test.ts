// The grouping decides whether a bracket reads as a tree or as a pile of cards,
// and `feedsForward` decides whether connector lines are drawn at all. Both are
// pure, and both are the part that used to be guessed at from column geometry.

import { describe, expect, it } from "vitest";
import { feedsForward, groupIntoSides } from "./BracketView";
import { match } from "./fixtures";

/** A four-team double-elimination draw, as the server links it. */
const doubleElimination = [
  match({
    id: "m1",
    round: 1,
    index: 0,
    winnerTo: { matchId: "m3", slot: 1 },
    loserTo: { matchId: "l1", slot: 1 },
  }),
  match({
    id: "m2",
    round: 1,
    index: 1,
    winnerTo: { matchId: "m3", slot: 2 },
    loserTo: { matchId: "l1", slot: 2 },
  }),
  match({ id: "m3", round: 2, index: 0, winnerTo: { matchId: "gf", slot: 1 } }),
  match({ id: "l1", bracket: "losers", round: 1, winnerTo: { matchId: "gf", slot: 2 } }),
  match({ id: "gf", bracket: "grandFinal", round: 3 }),
];

describe("groupIntoSides", () => {
  it("splits the halves and orders them the way they are played", () => {
    const sides = groupIntoSides(doubleElimination);
    expect(sides.map((side) => side.bracket)).toEqual(["winners", "losers", "grandFinal"]);
  });

  it("puts each round in its own column, in play order", () => {
    const [winners] = groupIntoSides(doubleElimination);
    expect(winners.columns.map((column) => column.round)).toEqual([1, 2]);
    expect(winners.columns[0].matches.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  it("orders a round by index, not by whatever order the server sent", () => {
    const shuffled = [
      match({ id: "b", round: 1, index: 2 }),
      match({ id: "a", round: 1, index: 0 }),
      match({ id: "c", round: 1, index: 1 }),
    ];
    expect(groupIntoSides(shuffled)[0].columns[0].matches.map((entry) => entry.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  it("keeps a swiss or free-for-all event as one side", () => {
    const swiss = [
      match({ id: "s1", bracket: "swiss", round: 1 }),
      match({ id: "s2", bracket: "swiss", round: 2 }),
    ];
    const sides = groupIntoSides(swiss);
    expect(sides).toHaveLength(1);
    expect(sides[0].columns).toHaveLength(2);
  });

  it("has nothing to group when the bracket has not been drawn", () => {
    expect(groupIntoSides([])).toEqual([]);
  });
});

describe("feedsForward", () => {
  it("is true when every match names where its winner goes", () => {
    // The whole reason the connectors can be drawn at all now: the edge is in
    // the data rather than inferred from how many cards are in each column.
    const [winners] = groupIntoSides(doubleElimination);
    expect(feedsForward(winners.columns)).toBe(true);
  });

  it("is false for a swiss event, where every round is the same size", () => {
    // Joining those with lines would claim a progression that does not exist.
    const swiss = groupIntoSides([
      match({ id: "s1", bracket: "swiss", round: 1, winnerTo: null }),
      match({ id: "s2", bracket: "swiss", round: 1, winnerTo: null }),
      match({ id: "s3", bracket: "swiss", round: 2, winnerTo: null }),
      match({ id: "s4", bracket: "swiss", round: 2, winnerTo: null }),
    ]);
    expect(feedsForward(swiss[0].columns)).toBe(false);
  });

  it("is false when a round's winners go somewhere other than the next column", () => {
    // A losers' bracket that feeds across rather than forward: drawing a line
    // from it to the card beside it would point at the wrong match.
    const across = groupIntoSides([
      match({ id: "a", round: 1, winnerTo: { matchId: "elsewhere", slot: 1 } }),
      match({ id: "b", round: 2, winnerTo: null }),
    ]);
    expect(feedsForward(across[0].columns)).toBe(false);
  });

  it("is true for a single column, which has nothing to join to", () => {
    expect(feedsForward(groupIntoSides([match()])[0].columns)).toBe(true);
  });
});
