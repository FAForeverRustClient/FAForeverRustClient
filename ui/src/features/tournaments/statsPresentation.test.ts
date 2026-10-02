import { describe, expect, it } from "vitest";
import { match, player, team, tourney } from "./fixtures";
import { eventStats, usageBuckets } from "./statsPresentation";
import type { MatchVeto } from "../../ipc/bindings";

const veto = (picks: string[], decider: string | null, done = true): MatchVeto =>
  ({
    picks: picks.map((map) => ({ map, by: "t1", game: null })),
    decider: decider === null ? null : { map: decider },
    done,
  }) as unknown as MatchVeto;

describe("eventStats", () => {
  const event = tourney({
    status: "finished",
    teamSize: 2,
    formation: "open",
    players: [
      player({ id: "p1", rating: 1000, teamId: "t1" }),
      player({ id: "p2", rating: 2001, teamId: "t1" }),
      player({ id: "p3", rating: null, teamId: "t2" }),
      player({ id: "p4", rating: 1500, teamId: null }),
    ],
    teams: [
      team({ id: "t1", name: "Blue", playerIds: ["p1", "p2"] }),
      team({ id: "t2", name: "Red", playerIds: ["p3"] }),
      team({ id: "t3", name: "Empty", playerIds: [] }),
    ],
    mapDb: [
      { id: "m1", name: "Seton" } as never,
      { id: "m2", name: "Canis" } as never,
      { id: "m3", name: "Loki" } as never,
    ],
    matches: [
      match({ id: "a", status: "done", score1: 2, score2: 1, veto: veto(["m1", "m2"], "m1") }),
      // A walkover: forfeited with no game, so it adds nothing to the games.
      match({ id: "b", status: "done", score1: 0, score2: -1, forfeit: { team: "t2" } as never }),
      // A forfeit after a game still counts that game.
      match({ id: "c", status: "done", score1: 1, score2: 0, forfeit: { team: "t2" } as never }),
      match({ id: "d", status: "ready" }),
      match({ id: "e", bracket: "freeForAll", status: "done", score1: 5, score2: 0 }),
    ],
  });
  const stats = eventStats(event);

  it("counts the series and games the website counts", () => {
    expect(stats.series).toBe(3);
    expect(stats.games).toBe(4);
    expect(stats.forfeits).toBe(2);
    expect(stats.decidedByForfeit).toBe(1);
    expect(stats.vetoesDone).toBe(1);
  });

  it("averages only the rated players, and counts who played on a team", () => {
    expect(stats.signups).toBe(4);
    expect(stats.rated).toBe(3);
    expect(stats.averageRating).toBe(1500);
    expect(stats.onTeams).toBe(3);
    expect(stats.teams).toBe(2);
    expect(stats.solo).toBe(false);
  });

  it("orders the teams by combined rating, a missing rating counting nothing", () => {
    expect(stats.teamTotals.map((total) => [total.name, total.rating])).toEqual([
      ["Blue", 3001],
      ["Red", 0],
    ]);
  });

  it("counts each veto pick and the decider, and lists unplayed maps last", () => {
    expect(stats.mapUse.map((use) => [use.name, use.count])).toEqual([
      ["Seton", 2],
      ["Canis", 1],
      ["Loki", 0],
    ]);
    expect(usageBuckets(stats.mapUse)).toEqual([
      { count: 2, maps: 1 },
      { count: 1, maps: 1 },
      { count: 0, maps: 1 },
    ]);
  });
});
