import { describe, expect, it } from "vitest";

import type { ChatUser, PlayerProfile } from "../../../ipc/bindings";
import { DEFAULT_ROSTER_VIEW, isRosterViewActive, readRosterView, shapeRoster, type RosterView } from "./rosterSort";

function user(name: string): ChatUser {
  return { name, elevation: "" };
}

function profile(login: string, ratings: Record<string, number>): PlayerProfile {
  return {
    id: 1,
    login,
    globalRating: 0,
    ratings: Object.entries(ratings).map(([leaderboard, rating]) => ({
      leaderboard,
      rating,
      mean: rating,
      deviation: 0,
      gamesPlayed: 1,
    })),
    country: "",
    clan: "",
    avatarUrl: "",
    avatarTooltip: "",
  };
}

const profiles = new Map([
  ["ada", profile("Ada", { global: 900, ladder_1v1: 1500 })],
  ["bert", profile("Bert", { global: 1400 })],
  ["cleo", profile("Cleo", { global: 1400, ladder_1v1: 800 })],
]);
const profileOf = (nickname: string) => profiles.get(nickname.toLowerCase());
const users = [user("ircOnly"), user("Ada"), user("Bert"), user("Cleo")];
const view = (changes: Partial<RosterView>): RosterView => ({ ...DEFAULT_ROSTER_VIEW, ...changes });
const names = (list: ChatUser[]) => list.map((u) => u.name);

describe("roster view (#513)", () => {
  it("leaves the server's order and everybody alone by default", () => {
    expect(isRosterViewActive(DEFAULT_ROSTER_VIEW)).toBe(false);
    expect(names(shapeRoster(users, DEFAULT_ROSTER_VIEW, profileOf))).toEqual(["ircOnly", "Ada", "Bert", "Cleo"]);
  });

  it("puts the highest rating on the chosen board first, ties in their order, unrated last", () => {
    expect(names(shapeRoster(users, view({ order: "rating" }), profileOf))).toEqual(["Bert", "Cleo", "Ada", "ircOnly"]);
    expect(names(shapeRoster(users, view({ order: "rating", board: "ladder_1v1" }), profileOf)))
      .toEqual(["Ada", "Cleo", "ircOnly", "Bert"]);
  });

  it("keeps only the players inside the range on the chosen board", () => {
    expect(names(shapeRoster(users, view({ min: 1000 }), profileOf))).toEqual(["Bert", "Cleo"]);
    expect(names(shapeRoster(users, view({ board: "ladder_1v1", max: 1000 }), profileOf))).toEqual(["Cleo"]);
  });

  it("never filters out whoever the caller keeps", () => {
    const kept = shapeRoster(users, view({ min: 5000 }), profileOf, (u) => u.name === "Ada");
    expect(names(kept)).toEqual(["Ada"]);
  });

  it("replaces a remembered view it cannot read", () => {
    expect(readRosterView({ board: "nonsense", order: "rating", min: 1200, max: Number.NaN }))
      .toEqual({ board: "global", order: "rating", min: 1200, max: null });
  });
});
