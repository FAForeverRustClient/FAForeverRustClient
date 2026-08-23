import { describe, expect, it } from "vitest";
import type { MatchmakerQueue, PlayerRatingSummary } from "../../ipc/bindings";
import { opponentsNearYou, ratingForQueue } from "./matchmakerRatings";

const queue = (numPlayers: number, brackets80: [number, number][], brackets75: [number, number][] = []): MatchmakerQueue => ({
  queueName: "ladder1v1",
  teamSize: 1,
  numPlayers,
  queuePopTimeSeconds: 60,
  ratingBrackets80: brackets80.map(([min, max]) => ({ min, max })),
  ratingBrackets75: brackets75.map(([min, max]) => ({ min, max })),
});

const rating = (technicalName: string, value: number): PlayerRatingSummary => ({
  leaderboardId: value,
  technicalName,
  name: technicalName,
  rating: value,
  mean: value,
  deviation: 0,
  gamesPlayed: 10,
  wonGames: 5,
  updateTime: "",
});

describe("matchmaker queue ratings", () => {
  it("matches lobby and API identifiers despite separators and casing", () => {
    const ratings = [
      rating("ladder_1v1", 1400),
      rating("tmm_2v2", 1500),
      rating("tmm_4v4_full_share", 1600),
    ];
    expect(ratingForQueue(ratings, "Ladder1v1")?.rating).toBe(1400);
    expect(ratingForQueue(ratings, "TMM-2V2")?.rating).toBe(1500);
    expect(ratingForQueue(ratings, "tmm4v4")?.rating).toBe(1600);
  });

  it("does not substitute the unrelated global rating", () => {
    expect(ratingForQueue([rating("global", 1800)], "tmm_4v4_full_share")).toBeNull();
  });
});

describe("who is queueing near you", () => {
  it("compares a settled rating against the tighter brackets", () => {
    const ladder = queue(6, [[1000, 1200]], [[600, 1600]]);
    expect(opponentsNearYou(ladder, rating("ladder_1v1", 1100))).toBe("near");
    expect(opponentsNearYou(ladder, rating("ladder_1v1", 1400))).toBe("far");
  });

  it("widens to the 75% brackets while a rating is still uncertain", () => {
    const ladder = queue(6, [[1000, 1200]], [[600, 1600]]);
    const unsure = { ...rating("ladder_1v1", 1400), deviation: 140 };
    expect(opponentsNearYou(ladder, unsure)).toBe("near");
  });

  it("says nothing rather than guessing without a rating or brackets", () => {
    expect(opponentsNearYou(queue(6, [[1000, 1200]]), null)).toBe("unknown");
    // Players in the queue but no published brackets: we cannot tell.
    expect(opponentsNearYou(queue(6, []), rating("ladder_1v1", 1100))).toBe("unknown");
    // Nobody in the queue at all: "nobody near you" is simply true.
    expect(opponentsNearYou(queue(0, []), rating("ladder_1v1", 1100))).toBe("far");
  });
});
