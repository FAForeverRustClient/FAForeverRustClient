import { describe, expect, it } from "vitest";

import type { ChatUser, PlayerProfile } from "../../../ipc/bindings";
import { isRosterSort, sortRoster } from "./rosterSort";

function user(name: string): ChatUser {
  return { name } as ChatUser;
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

describe("roster sort (#513)", () => {
  it("leaves the server's order alone by default", () => {
    expect(sortRoster(users, "name", profileOf).map((u) => u.name)).toEqual(["ircOnly", "Ada", "Bert", "Cleo"]);
  });

  it("puts the highest rating on the chosen board first, ties in their order", () => {
    expect(sortRoster(users, "global", profileOf).map((u) => u.name)).toEqual(["Bert", "Cleo", "Ada", "ircOnly"]);
  });

  it("reads the board that was chosen, and puts those unrated on it last", () => {
    expect(sortRoster(users, "ladder_1v1", profileOf).map((u) => u.name)).toEqual(["Ada", "Cleo", "ircOnly", "Bert"]);
  });

  it("accepts only sorts it knows when one is remembered", () => {
    expect(isRosterSort("tmm_2v2")).toBe(true);
    expect(isRosterSort("rating")).toBe(false);
    expect(isRosterSort(3)).toBe(false);
  });
});
