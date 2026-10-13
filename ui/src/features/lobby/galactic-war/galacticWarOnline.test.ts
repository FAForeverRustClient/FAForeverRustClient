import { describe, expect, it } from "vitest";

import type { GalacticWarFaction, GalacticWarStatistics } from "../../../ipc/bindings";
import { onlineCommanders } from "./galacticWarOnline";

function faction(name: string, numOnlineAvatars: number): GalacticWarFaction {
  return {
    id: 0,
    name,
    longName: name,
    numAvatars: 0,
    numAliveAvatars: 0,
    numOnlineAvatars,
    numPlanets: 0,
  };
}

describe("Galactic War players online", () => {
  it("counts the factions' online avatars, as the game does, not the gateway's connections", () => {
    // The report: the game showed UEF 1 and everyone else 0, the client 6.
    const statistics = {
      season: { numOnlinePlayers: 6 },
      factions: [faction("UEF", 1), faction("Aeon", 0), faction("Cybran", 0), faction("Seraphim", 0)],
    } as unknown as GalacticWarStatistics;
    expect(onlineCommanders(statistics)).toBe(1);
  });

  it("is nobody when nothing has been loaded", () => {
    expect(onlineCommanders(null)).toBe(0);
    expect(onlineCommanders({})).toBe(0);
  });
});
