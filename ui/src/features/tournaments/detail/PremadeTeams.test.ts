// Premade teams are grouped the way the service groups them: by the name
// players typed, whatever its case, with pending signups left out.

import { describe, expect, it } from "vitest";
import { premadeGroups } from "./PremadeTeams";
import { player, tourney } from "../fixtures";

describe("premadeGroups", () => {
  it("groups by team name case-insensitively, largest first", () => {
    const event = tourney({
      players: [
        player({ id: "a", teamName: "Blue", rating: 1000 }),
        player({ id: "b", teamName: "blue ", rating: 1500 }),
        player({ id: "c", teamName: "Red" }),
        player({ id: "d", teamName: "" }),
        player({ id: "e", teamName: "Red", pending: true }),
      ],
    });
    const groups = premadeGroups(event);
    expect(groups.map((group) => group.members.map((held) => held.id))).toEqual([["b", "a"], ["c"]]);
    expect(groups[0].name).toBe("blue");
  });
});
