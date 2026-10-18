import { describe, expect, it } from "vitest";
import type { ReplayPlayer, VaultReplay } from "../../../ipc/bindings";
import { recentGameSide } from "./MatchmakerRecentGames";

const player = (name: string, outcome: string, ratingChange: number | null = null): ReplayPlayer => ({
  name,
  avatarUrl: null,
  faction: 1,
  rating: 1000,
  ratingChange,
  outcome,
  score: null,
});

const replay = (teams: ReplayPlayer[][]): VaultReplay => ({
  uid: 1,
  teams: teams.map((players, index) => ({ team: index + 2, players })),
} as unknown as VaultReplay);

describe("a recent game from the player's side", () => {
  it("finds the player whatever the case, and lists the other team", () => {
    const side = recentGameSide(
      replay([[player("Ada", "DEFEAT", -5), player("Bob", "DEFEAT")], [player("Cid", "VICTORY"), player("Dee", "VICTORY")]]),
      "ada",
    );
    expect(side.me?.name).toBe("Ada");
    expect(side.me?.ratingChange).toBe(-5);
    expect(side.mode).toBe("2v2");
    expect(side.opponents).toEqual(["Cid", "Dee"]);
  });

  it("does not count a teammate as an opponent", () => {
    const side = recentGameSide(replay([[player("Ada", "VICTORY")], [player("Bob", "DEFEAT")]]), "Ada");
    expect(side.mode).toBe("1v1");
    expect(side.opponents).toEqual(["Bob"]);
  });

  it("still describes a game the player cannot be found in", () => {
    const side = recentGameSide(replay([[player("Bob", "VICTORY")], [player("Cid", "DEFEAT")]]), "Ada");
    expect(side.me).toBeNull();
    expect(side.outcome).toBe("");
    expect(side.mode).toBe("1v1");
    expect(side.opponents).toEqual(["Bob", "Cid"]);
  });

  it("reads the team's result, not the player's own army (#589)", () => {
    // Ada's commander died, the team still won: the server stores her army
    // as a defeat and her rating change as a win.
    const side = recentGameSide(
      replay([
        [player("Ada", "DEFEAT", 11), player("Bob", "VICTORY"), player("Cid", "DEFEAT")],
        [player("Dee", "DEFEAT"), player("Eve", "DEFEAT"), player("Fay", "DEFEAT")],
      ]),
      "Ada",
    );
    expect(side.outcome).toBe("victory");
    expect(side.me?.ratingChange).toBe(11);
  });

  it("says a lost game is lost", () => {
    const side = recentGameSide(replay([[player("Ada", "DEFEAT")], [player("Bob", "VICTORY")]]), "Ada");
    expect(side.outcome).toBe("defeat");
  });
});
