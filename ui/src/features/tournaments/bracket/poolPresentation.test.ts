// The service's pool fallback, in its order: the match's own pool, the
// round's, the semi-finals' for the 3rd place match, then the first pool.

import { describe, expect, it } from "vitest";
import { poolForMatch, poolForRoundOf } from "./poolPresentation";
import { match, tourney } from "../fixtures";
import type { MapPool } from "../../../ipc/bindings";

const pool = (id: string): MapPool => ({
  id,
  name: id,
  mapIds: [],
  sequence: [],
  bestOf: 3,
  published: true,
  publishAt: null,
});

describe("poolForMatch", () => {
  const pools = [pool("first"), pool("semis"), pool("own")];

  it("takes the match's own pool over its round's", () => {
    const event = tourney({
      mapPools: pools,
      poolAssign: [
        { round: "wb:1", poolId: "semis" },
        { round: "match:m1", poolId: "own" },
      ],
    });
    expect(poolForMatch(event, match({ id: "m1", round: 1 }))).toEqual({ pool: pools[2], source: "match" });
  });

  it("plays the 3rd place match on the semi-finals' pool", () => {
    const event = tourney({ mapPools: pools, poolAssign: [{ round: "wb:2", poolId: "semis" }] });
    expect(poolForRoundOf(event, "thirdPlace", 3)).toEqual({ pool: pools[1], source: "semis" });
  });

  it("falls back to the first pool", () => {
    const event = tourney({ mapPools: pools, poolAssign: [] });
    expect(poolForMatch(event, match({ round: 4 }))?.source).toBe("default");
    expect(poolForRoundOf(tourney({ mapPools: [], poolAssign: [] }), "winners", 1)).toBeNull();
  });
});
