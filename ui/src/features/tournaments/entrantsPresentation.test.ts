// The Players section's side column, counted from the detail.

import { describe, expect, it } from "vitest";
import { fieldSummary } from "./entrantsPresentation";
import { player, team, tourney } from "./fixtures";

describe("fieldSummary", () => {
  it("counts players in a solo event against its limits, and sums up their ratings", () => {
    const event = tourney({
      teamSize: 1,
      playerCount: 3,
      minTeams: 8,
      maxTeams: 16,
      players: [
        player({ id: "a", rating: 1500 }),
        player({ id: "b", rating: 1001 }),
        player({ id: "c", rating: null }),
        player({ id: "d", rating: 1200 }),
      ],
    });
    expect(fieldSummary(event)).toEqual({
      unit: "players",
      count: 3,
      min: 8,
      max: 16,
      ratings: { high: 1500, average: 1234, low: 1001 },
    });
  });

  it("counts full teams in a team event, and gives no spread for a single rating", () => {
    const event = tourney({
      teamSize: 2,
      playerCount: 3,
      teams: [team({ id: "x", playerIds: ["a", "b"] }), team({ id: "y", playerIds: ["c"] })],
      players: [player({ id: "a", rating: 1500 }), player({ id: "b", rating: null })],
    });
    const summary = fieldSummary(event);
    expect(summary.unit).toBe("teams");
    expect(summary.count).toBe(1);
    expect(summary.ratings).toBeNull();
  });
});
