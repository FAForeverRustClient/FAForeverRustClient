import { describe, expect, it } from "vitest";
import type { MatchmakerMapPool } from "../../ipc/bindings";
import { findMatchingBracket } from "./MatchmakerMapPoolModal";

const pool = (id: number, minRating: number | null, maxRating: number | null): MatchmakerMapPool => ({
  id,
  name: `Pool ${id}`,
  minRating,
  maxRating,
  vetoTokensPerPlayer: 2,
  maxTokensPerMap: 1,
  minimumMapsAfterVeto: 1,
  maps: [],
});

describe("findMatchingBracket", () => {
  const pools: MatchmakerMapPool[] = [
    pool(1, null, 500),
    pool(2, 500, 1000),
    pool(3, 1000, 1500),
    pool(4, 1500, 2000),
    pool(5, 2000, null),
  ];

  it("selects the matching pool for intermediate ratings", () => {
    expect(findMatchingBracket(pools, 1594)?.id).toBe(4);
    expect(findMatchingBracket(pools, 750)?.id).toBe(2);
    expect(findMatchingBracket(pools, 1200)?.id).toBe(3);
  });

  it("handles boundary ratings correctly", () => {
    expect(findMatchingBracket(pools, 500)?.id).toBe(2);
    expect(findMatchingBracket(pools, 1000)?.id).toBe(3);
    expect(findMatchingBracket(pools, 1500)?.id).toBe(4);
    expect(findMatchingBracket(pools, 2000)?.id).toBe(5);
  });

  it("handles lowest and highest unbounded brackets", () => {
    expect(findMatchingBracket(pools, 300)?.id).toBe(1);
    expect(findMatchingBracket(pools, 2500)?.id).toBe(5);
  });

  it("returns null when player rating is null or pools is empty", () => {
    expect(findMatchingBracket(pools, null)).toBeNull();
    expect(findMatchingBracket([], 1594)).toBeNull();
  });
});
