import { describe, expect, it } from "vitest";

import type { League, ReplayQuery } from "../../ipc/bindings";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import {
  COOP_FEATURED_MOD,
  replayGameModes,
  selectedGameMode,
  withGameMode,
} from "./replayGameModes";

const league = (technicalName: string, name: string): League => ({
  id: 1,
  technicalName,
  name,
  description: "",
});

const leagues = [
  league("global", "Global"),
  league("ladder_1v1", "1v1"),
  league("tmm_2v2", "2v2"),
];

const query = (fields: Partial<ReplayQuery>): ReplayQuery => ({ ...EMPTY_REPLAY_QUERY, ...fields });

describe("the modes on offer", () => {
  it("is the API's own league list, plus any and co-op", () => {
    expect(replayGameModes(leagues).map((mode) => mode.id)).toEqual([
      "",
      "global",
      "ladder_1v1",
      "tmm_2v2",
      COOP_FEATURED_MOD,
    ]);
  });

  it("offers custom games even when the league catalogue never arrived", () => {
    expect(replayGameModes([]).map((mode) => mode.id)).toEqual(["", "global", COOP_FEATURED_MOD]);
  });

  it("calls the global leaderboard what a player calls it", () => {
    const global = replayGameModes(leagues).find((mode) => mode.id === "global");
    expect(global?.label).not.toBe("global");
  });
});

describe("selecting one", () => {
  it("asks for a leaderboard, and only that", () => {
    const next = withGameMode(query({}), "ladder_1v1");
    expect(next.leaderboards).toEqual(["ladder_1v1"]);
    expect(next.featuredMods).toEqual([]);
  });

  it("asks for the co-op featured mod instead, because co-op has no leaderboard", () => {
    const next = withGameMode(query({ leaderboards: ["global"] }), COOP_FEATURED_MOD);
    expect(next.featuredMods).toEqual([COOP_FEATURED_MOD]);
    expect(next.leaderboards).toEqual([]);
  });

  it("leaves a mod filter set in the advanced panel alone", () => {
    const next = withGameMode(query({ featuredMods: ["fafbeta"] }), "global");
    expect(next.featuredMods).toEqual(["fafbeta"]);
    expect(next.leaderboards).toEqual(["global"]);
  });

  it("takes its own co-op entry back out when the mode changes", () => {
    const coop = withGameMode(query({ featuredMods: ["fafbeta"] }), COOP_FEATURED_MOD);
    expect(coop.featuredMods).toEqual(["fafbeta", COOP_FEATURED_MOD]);
    expect(withGameMode(coop, "").featuredMods).toEqual(["fafbeta"]);
  });

  it("starts a new search rather than paging the old one", () => {
    expect(withGameMode(query({ page: 4 }), "tmm_2v2").page).toBe(1);
  });
});

describe("reading the mode back out of a query", () => {
  it("recognises a leaderboard search", () => {
    expect(selectedGameMode(query({ leaderboards: ["tmm_2v2"] }))).toBe("tmm_2v2");
  });

  it("recognises a co-op mod filter, however it was set", () => {
    expect(selectedGameMode(query({ featuredMods: ["coop"] }))).toBe(COOP_FEATURED_MOD);
  });

  it("answers any for a search that is not one of these questions", () => {
    expect(selectedGameMode(query({}))).toBe("");
    expect(selectedGameMode(query({ featuredMods: ["fafbeta"] }))).toBe("");
    expect(selectedGameMode(query({ leaderboards: ["global", "ladder_1v1"] }))).toBe("");
  });
});
