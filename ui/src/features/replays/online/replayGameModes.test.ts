import { describe, expect, it } from "vitest";

import type { RatingLeaderboard, ReplayQuery } from "../../../ipc/bindings";
import { EMPTY_REPLAY_QUERY } from "../../../shared/replayQuery";
import {
  COOP_FEATURED_MOD,
  replayGameModes,
  selectedGameModes,
  withGameModes,
} from "./replayGameModes";

const board = (technicalName: string, name: string): RatingLeaderboard => ({
  id: 1,
  technicalName,
  name,
  description: "",
});

// The `/data/leaderboard` names, which are the ones a replay's rating changes
// carry. The `/data/league` list, which this once read, names the same modes
// `1v1_league` and `2v2_league`: a search for those matched nothing.
const boards = [
  board("global", "Global"),
  board("ladder_1v1", "1v1"),
  board("tmm_2v2", "2v2"),
];

const query = (fields: Partial<ReplayQuery>): ReplayQuery => ({ ...EMPTY_REPLAY_QUERY, ...fields });

describe("the modes on offer", () => {
  it("is the API's own leaderboard list, plus co-op", () => {
    expect(replayGameModes(boards).map((mode) => mode.id)).toEqual([
      "global",
      "ladder_1v1",
      "tmm_2v2",
      COOP_FEATURED_MOD,
    ]);
  });

  it("offers custom games even when the catalogue never arrived", () => {
    expect(replayGameModes([]).map((mode) => mode.id)).toEqual(["global", COOP_FEATURED_MOD]);
  });

  it("calls the global leaderboard what a player calls it", () => {
    const global = replayGameModes(boards).find((mode) => mode.id === "global");
    expect(global?.label).not.toBe("global");
  });
});

describe("selecting modes", () => {
  it("asks for leaderboards, and only those", () => {
    const next = withGameModes(query({}), ["global", "ladder_1v1"]);
    expect(next.leaderboards).toEqual(["global", "ladder_1v1"]);
    expect(next.featuredMods).toEqual([]);
  });

  it("asks for co-op through the featured mod, because co-op has no leaderboard", () => {
    const next = withGameModes(query({}), [COOP_FEATURED_MOD]);
    expect(next.featuredMods).toEqual([COOP_FEATURED_MOD]);
    expect(next.leaderboards).toEqual([]);
  });

  it("keeps co-op beside leaderboards, which the query builder ORs", () => {
    const next = withGameModes(query({}), ["global", COOP_FEATURED_MOD]);
    expect(next.leaderboards).toEqual(["global"]);
    expect(next.featuredMods).toEqual([COOP_FEATURED_MOD]);
  });

  it("leaves a mod filter set in the advanced panel alone", () => {
    const next = withGameModes(query({ featuredMods: ["fafbeta"] }), ["global"]);
    expect(next.featuredMods).toEqual(["fafbeta"]);
    expect(next.leaderboards).toEqual(["global"]);
  });

  it("takes its own co-op entry back out when co-op is unticked", () => {
    const coop = withGameModes(query({ featuredMods: ["fafbeta"] }), [COOP_FEATURED_MOD]);
    expect(coop.featuredMods).toEqual(["fafbeta", COOP_FEATURED_MOD]);
    expect(withGameModes(coop, []).featuredMods).toEqual(["fafbeta"]);
  });

  it("starts a new search rather than paging the old one", () => {
    expect(withGameModes(query({ page: 4 }), ["tmm_2v2"]).page).toBe(1);
  });
});

describe("reading the modes back out of a query", () => {
  it("recognises leaderboard searches", () => {
    expect(selectedGameModes(query({ leaderboards: ["global", "tmm_2v2"] }))).toEqual(["global", "tmm_2v2"]);
  });

  it("recognises a co-op mod filter, however it was set", () => {
    expect(selectedGameModes(query({ featuredMods: ["coop"] }))).toEqual([COOP_FEATURED_MOD]);
  });

  it("answers any for a search that asks for no mode", () => {
    expect(selectedGameModes(query({}))).toEqual([]);
    expect(selectedGameModes(query({ featuredMods: ["fafbeta"] }))).toEqual([]);
  });
});
