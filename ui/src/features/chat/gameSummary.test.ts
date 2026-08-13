import { describe, expect, it } from "vitest";
import type { Game, PlayerProfile, SocialState } from "../../ipc/bindings";
import { gamePresenceForPlayer, gameTeamSummaries } from "./gameSummary";

const game = (id: number, host: string, teams: Record<string, string[]>): Game => ({
  id,
  title: `Game ${id}`,
  host,
  players: Object.values(teams).flat().length,
  maxPlayers: 8,
  map: "scmp_009",
  modName: "faf",
  averageRating: 1_200,
  passwordProtected: false,
  visibility: "public",
  gameType: "custom",
  launchedAt: null,
  hostedAt: null,
  ratingMin: null,
  ratingMax: null,
  teams,
  simMods: {},
});

const profile = (login: string, rating: number, country: string): PlayerProfile => ({
  id: rating,
  login,
  globalRating: rating,
  ratings: [],
  country,
  clan: "",
  avatarUrl: "",
  avatarTooltip: "",
});

it("prefers a live game and matches login casing", () => {
  const open = game(1, "Host", { "1": ["Player"] });
  const live = game(2, "Other", { "2": ["PLAYER"] });
  expect(gamePresenceForPlayer([open], [live], "player")).toEqual({
    game: live,
    status: "playing",
  });
});

it("distinguishes hosting from waiting in an open lobby", () => {
  const open = game(1, "Host", { "1": ["Host", "Guest"] });
  expect(gamePresenceForPlayer([open], [], "host")?.status).toBe("hosting");
  expect(gamePresenceForPlayer([open], [], "guest")?.status).toBe("lobbying");
});

describe("game team summaries", () => {
  it("adds known player ratings and keeps observers last", () => {
    const social: SocialState = {
      friends: [],
      foes: [],
      players: [profile("Alpha", 1_200, "us"), profile("Bravo", 1_400, "de")],
    };
    const teams = gameTeamSummaries(
      game(1, "Alpha", { "-1": ["Observer"], "2": ["Bravo"], "1": ["Alpha", "Unknown"] }),
      social,
    );

    expect(teams.map((team) => team.label)).toEqual(["Team 1", "Team 2", "Observers"]);
    expect(teams[0].rating).toBe(1_200);
    expect(teams[0].players[1].rating).toBeNull();
    expect(teams[1].rating).toBe(1_400);
    expect(teams[2].rating).toBeNull();
  });
});
