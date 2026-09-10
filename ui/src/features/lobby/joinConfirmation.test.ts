import { describe, expect, it } from "vitest";
import type { Game, InstalledMod } from "../../ipc/bindings";
import { missingSimMods } from "./joinConfirmation";

function game(simMods: Record<string, string>): Game {
  return {
    id: 1,
    title: "Modded madness",
    host: "Commander",
    players: 2,
    maxPlayers: 8,
    map: "scmp_009",
    modName: "faf",
    averageRating: 1200,
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    teams: {},
    simMods,
  };
}

const installed = (...uids: string[]) =>
  uids.map((uid) => ({ uid }) as unknown as InstalledMod);

describe("what joining a lobby would download", () => {
  it("names the mods that are not on disk", () => {
    const missing = missingSimMods(game({ AAA: "Total Mayhem", BBB: "Blackops" }), installed("AAA"));
    expect(missing).toEqual(["Blackops"]);
  });

  it("matches uids case-insensitively, the way the lobby sends them", () => {
    // The lobby server's casing and the one in mod_info.lua are not the same
    // string often enough to rely on, and a false "missing" here would prompt
    // for a download that is not going to happen.
    expect(missingSimMods(game({ aaa: "Total Mayhem" }), installed("AAA"))).toEqual([]);
  });

  it("is empty for an unmodded lobby, which is what keeps the prompt out of the way", () => {
    expect(missingSimMods(game({}), installed())).toEqual([]);
  });

  it("falls back to the uid when the lobby sent no name", () => {
    expect(missingSimMods(game({ ZZZ: "" }), installed())).toEqual(["ZZZ"]);
  });

  it("lists them in a stable order rather than the object's", () => {
    const missing = missingSimMods(game({ B: "Zeta", A: "Alpha" }), installed());
    expect(missing).toEqual(["Alpha", "Zeta"]);
  });
});
