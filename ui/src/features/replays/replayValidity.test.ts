import { describe, expect, it } from "vitest";
import type { OnlineLookup, ReplayTeam, VaultReplay } from "../../ipc/bindings";
import { hasGameResult, localRatingNote, notRatedReason } from "./replayValidity";

const teamsWithChange: ReplayTeam[] = [
  {
    team: 1,
    players: [{ name: "Nuggets", faction: 1, rating: 1800, ratingChange: 12, outcome: "VICTORY", score: 1 }],
  },
];

const teamsWithoutChange: ReplayTeam[] = [
  {
    team: 1,
    players: [{ name: "Nuggets", faction: 1, rating: 1800, ratingChange: null, outcome: "", score: null }],
  },
];

function found(validity: string): OnlineLookup {
  const replay = { uid: 51, teams: teamsWithChange, validity } as unknown as VaultReplay;
  return { type: "found", payload: replay };
}

describe("localRatingNote", () => {
  // The bug this file exists for: a local replay borrowed the online client's
  // "the server has not rated it yet", which is never true of a file on disk.
  const pending = notRatedReason("");

  it("says why a file with no game id has no rating change", () => {
    const note = localRatingNote(0, undefined, teamsWithoutChange);
    expect(note).not.toBe(pending);
    expect(note).toContain("no game id");
  });

  it("reports the lookup while it is in flight, not a server verdict", () => {
    for (const lookup of [undefined, { type: "loading" } as OnlineLookup]) {
      expect(localRatingNote(51, lookup, teamsWithoutChange)).not.toBe(pending);
    }
  });

  it("falls silent once the vault produced a rated game", () => {
    expect(localRatingNote(51, found("VALID"), teamsWithChange)).toBeNull();
  });

  it("gives the server's own reason for a game the vault refused to rate", () => {
    expect(localRatingNote(51, found("HAS_AI"), teamsWithoutChange)).toBe(notRatedReason("HAS_AI"));
  });

  it("separates a game the vault does not have from a lookup that failed", () => {
    const missing = localRatingNote(51, { type: "missing" }, teamsWithoutChange);
    const failed = localRatingNote(51, { type: "failed", payload: { reason: "offline" } }, teamsWithoutChange);
    expect(missing).not.toBe(failed);
    expect(missing).not.toBe(pending);
    expect(failed).not.toBe(pending);
  });
});

describe("hasGameResult", () => {
  it("is true for a valid game the server recorded outcomes for", () => {
    expect(hasGameResult("VALID", teamsWithChange)).toBe(true);
  });

  it("is true for a valid game whose rating journal has not arrived", () => {
    // The report: a game that plainly was rated, with a dead "Game result"
    // button, because the listing carried outcomes and no journal.
    const outcomesOnly: ReplayTeam[] = [
      {
        team: 1,
        players: [{ name: "wilson_", faction: 1, rating: 1800, ratingChange: null, outcome: "VICTORY", score: 1 }],
      },
    ];
    expect(hasGameResult("VALID", outcomesOnly)).toBe(true);
  });

  it("is false for a valid game with nothing recorded at all", () => {
    expect(hasGameResult("VALID", teamsWithoutChange)).toBe(false);
  });

  it("is false for a game the server refused, outcomes or not", () => {
    expect(hasGameResult("HAS_AI", teamsWithChange)).toBe(false);
  });
});

describe("notRatedReason", () => {
  it("never reports VALID as the reason a game was not rated", () => {
    // "Game was not rated. Reason: VALID" is a contradiction, and it is what
    // the panel printed for every valid game still waiting for its journal.
    expect(notRatedReason("VALID")).toBe(notRatedReason(""));
    expect(notRatedReason("VALID")).not.toContain("VALID");
  });

  it("still names a reason the server actually gave", () => {
    expect(notRatedReason("SOME_NEW_STATE")).toContain("SOME_NEW_STATE");
  });
});
