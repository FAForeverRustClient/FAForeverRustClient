// The submit rules are the server's, mirrored so the player finds out about a
// missing replay id from the form rather than from a refused request that
// throws their score away.

import { describe, expect, it } from "vitest";
import { isSubmittable, newGames } from "./MatchReportDialog";
import { match } from "./fixtures";

describe("newGames", () => {
  it("counts what the report adds to the confirmed score", () => {
    expect(newGames(match({ score1: null, score2: null }), 2, 0)).toBe(2);
    expect(newGames(match({ score1: 1, score2: 1 }), 2, 1)).toBe(1);
  });

  it("starts a handicapped grand final at 1-0, as the server does", () => {
    // The upper-bracket side arrives a game up, so an absent score is not zero.
    expect(newGames(match({ handicap: 1, score1: null, score2: null }), 2, 0)).toBe(1);
  });

  it("never goes negative when a score is somehow lower than confirmed", () => {
    expect(newGames(match({ score1: 2, score2: 1 }), 1, 0)).toBe(0);
  });
});

describe("isSubmittable", () => {
  const bo3 = match({ bestOf: 3 });

  it("wants exactly one replay id per new game", () => {
    expect(isSubmittable(bo3, 2, 0, ["22334455", "22334456"])).toBe(true);
    expect(isSubmittable(bo3, 2, 0, ["22334455"])).toBe(false);
    expect(isSubmittable(bo3, 2, 0, ["1", "2", "3"])).toBe(false);
  });

  it("ignores a blank row the player tabbed past", () => {
    // The server counts them, so a blank one would cost the submission for a
    // reason the form never showed.
    expect(isSubmittable(bo3, 2, 0, ["22334455", "  ", "22334456"])).toBe(true);
  });

  it("refuses a score that cannot happen in the series", () => {
    expect(isSubmittable(bo3, 3, 0, ["a", "b", "c"])).toBe(false);
    expect(isSubmittable(bo3, 2, 2, ["a", "b", "c", "d"])).toBe(false);
    expect(isSubmittable(bo3, -1, 0, [])).toBe(false);
  });

  it("refuses a report that adds nothing", () => {
    expect(isSubmittable(match({ bestOf: 3, score1: 1, score2: 1 }), 1, 1, [])).toBe(false);
  });

  it("handles a best of one", () => {
    expect(isSubmittable(match({ bestOf: 1 }), 1, 0, ["22334455"])).toBe(true);
  });
});
