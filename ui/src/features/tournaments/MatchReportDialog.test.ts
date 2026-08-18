// The submit rules are the server's, mirrored so the player finds out about a
// missing replay id from the form rather than from a refused request that
// throws their score away.
//
// These cases are the readable ones, kept for what they say out loud. The
// authority is now the conformance fixture: `reducer.conformance.test.ts` replays
// what `MatchReport::is_submittable` actually returns, which is what caught the
// two sides disagreeing about a blank replay row.

import { describe, expect, it } from "vitest";
import { isSubmittable, newGames } from "../../shared/tourneyRules";
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

  it("takes a score the series can actually produce", () => {
    expect(isSubmittable(bo3, 2, 0)).toBe(true);
    expect(isSubmittable(bo3, 2, 1)).toBe(true);
    expect(isSubmittable(match({ bestOf: 1 }), 1, 0)).toBe(true);
  });

  it("refuses a score that cannot happen in the series", () => {
    expect(isSubmittable(bo3, 3, 0)).toBe(false);
    expect(isSubmittable(bo3, 2, 2)).toBe(false);
    expect(isSubmittable(bo3, -1, 0)).toBe(false);
  });

  it("keeps the upper bracket's head start in a handicapped grand final", () => {
    // The server refuses 0-x there: the match starts 1-0.
    const gf = match({ bestOf: 5, handicap: 1 });
    expect(isSubmittable(gf, 0, 2)).toBe(false);
    expect(isSubmittable(gf, 1, 2)).toBe(true);
  });

  it("allows a lower score, because this is also the correction path", () => {
    // `report` undoes a finished match and sets it again, so an organiser fixing
    // a wrong 2-0 down to 1-2 must not be blocked by the form.
    expect(isSubmittable(match({ bestOf: 3, score1: 2, score2: 0 }), 1, 2)).toBe(true);
  });

  it("no longer asks for replay ids", () => {
    // Only `report_submit` requires them, and that path is not used: the
    // organiser records every result.
    expect(isSubmittable(bo3, 2, 0)).toBe(true);
  });
});
