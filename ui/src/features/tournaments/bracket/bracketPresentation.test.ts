// The website's bracket rules: byes are not games, columns are named from
// their depth, an early finish greys what it left unplayed, and the preview
// has the shape the draw will have.

import { describe, expect, it } from "vitest";
import {
  bracketPreview,
  columnLabel,
  isPhantom,
  neverPlayed,
  previewTeamCount,
  seedOrder,
} from "./bracketPresentation";
import { match, player, team, tourney } from "../fixtures";

const t = (key: string, values?: Record<string, string | number>) =>
  values === undefined ? key : `${key}${JSON.stringify(values)}`;

describe("isPhantom", () => {
  it("is a match with a bye on either side", () => {
    expect(isPhantom(match({ team1: "BYE", team2: "t2" }))).toBe(true);
    expect(isPhantom(match({ team1: null, team2: "BYE" }))).toBe(true);
    expect(isPhantom(match({ team1: "t1", team2: null }))).toBe(false);
  });
});

describe("columnLabel", () => {
  it("names a single elimination's final and semi-final", () => {
    const event = tourney({ bracketKind: "single" });
    expect(columnLabel(event, "winners", 3, 3, t as never)).toBe("tournaments.bracket.colFinal");
    expect(columnLabel(event, "winners", 2, 3, t as never)).toBe("tournaments.bracket.colSemi");
    expect(columnLabel(event, "winners", 1, 3, t as never)).toBe('tournaments.bracket.round{"round":1}');
  });

  it("names a double elimination's winners final and losers rounds", () => {
    const event = tourney({ bracketKind: "double" });
    expect(columnLabel(event, "winners", 3, 3, t as never)).toBe("tournaments.bracket.colWbFinal");
    expect(columnLabel(event, "losers", 4, 4, t as never)).toBe("tournaments.bracket.colLbFinal");
    expect(columnLabel(event, "losers", 2, 4, t as never)).toBe('tournaments.bracket.colLbRound{"round":2}');
  });
});

describe("neverPlayed", () => {
  const finish = { at: 1, by: "", automatic: true, target: 4, alive: 4, names: [] };

  it("greys only the listed matches", () => {
    const event = tourney({ earlyFinish: { ...finish, unplayed: ["m2"] } });
    expect(neverPlayed(event, match({ id: "m2" }))).toBe(true);
    expect(neverPlayed(event, match({ id: "m3" }))).toBe(false);
    expect(neverPlayed(event, match({ id: "m2", status: "done" }))).toBe(false);
  });

  it("counts every unfinished match for a record without the list", () => {
    const event = tourney({ earlyFinish: { ...finish, unplayed: null } });
    expect(neverPlayed(event, match({ id: "m9" }))).toBe(true);
  });
});

describe("previewTeamCount", () => {
  it("counts only full teams during signups, and the cap holds", () => {
    const event = tourney({
      status: "signup",
      teamSize: 2,
      maxTeams: 2,
      teams: [
        team({ id: "a", playerIds: ["p1", "p2"] }),
        team({ id: "b", playerIds: ["p3", "p4"] }),
        team({ id: "c", playerIds: ["p5", "p6"] }),
        team({ id: "d", playerIds: ["p7"] }),
      ],
    });
    expect(previewTeamCount(event)).toBe(2);
  });

  it("estimates from the signups before any team forms", () => {
    const players = ["p1", "p2", "p3", "p4", "p5"].map((id) => player({ id }));
    expect(previewTeamCount(tourney({ status: "signup", teamSize: 1, players }))).toBe(5);
  });
});

describe("bracketPreview", () => {
  it("uses the standard seed layout", () => {
    expect(seedOrder(8)).toEqual([1, 8, 5, 4, 3, 6, 7, 2]);
  });

  it("leaves byes out of six teams and names who they pass through", () => {
    const players = ["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => player({ id }));
    const preview = bracketPreview(tourney({ status: "signup", teamSize: 1, bracketKind: "single", players }), t);
    expect(preview.teams).toBe(6);
    const [first, second] = preview.winners;
    // Seeds 1 and 2 meet a bye in round 1, so two of four slots are games.
    expect(first.cards.filter((card) => card !== null)).toHaveLength(2);
    // Seed 1 goes straight into round 2 against the winner of 4 v 5.
    expect(second.cards[0]?.one.seed).toBe(1);
    expect(second.cards[0]?.two.text).toContain("tournaments.matches.winnerOf");
  });

  it("draws a losers bracket for a double elimination, byes' phantoms left out", () => {
    const players = ["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => player({ id }));
    const preview = bracketPreview(tourney({ status: "signup", teamSize: 1, bracketKind: "double", players }), t);
    expect(preview.losers).toHaveLength(4);
    // Losers round 1 takes round 1's losers, and only two round 1 games exist.
    expect(preview.losers[0].cards.every((card) => card === null)).toBe(true);
    expect(preview.winners[preview.winners.length - 1].bracket).toBe("grandFinal");
  });
});
