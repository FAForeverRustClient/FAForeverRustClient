// The map editor's two rules that mirror the service: spawn rows are kept
// ascending with no repeats, as `cleanMapSpec` stores them, and a spec with
// nothing in it is no spec at all.

import { describe, expect, it } from "vitest";
import { normalisedSpec, toggledSpawn } from "./MapEditor";
import { copyTargets } from "./CopyOrderDialog";
import type { MapPool } from "../../../ipc/bindings";

describe("toggledSpawn", () => {
  it("adds a number in order and takes it out again", () => {
    expect(toggledSpawn([1, 5], 3)).toEqual([1, 3, 5]);
    expect(toggledSpawn([1, 3, 5], 3)).toEqual([1, 5]);
  });
});

describe("normalisedSpec", () => {
  const empty = { team1Spawns: [], team2Spawns: [], closedSpawns: [], closedMexSpawns: [], size: "" };

  it("stores nothing for an empty spec", () => {
    expect(normalisedSpec(empty)).toBeNull();
  });

  it("keeps a spec with only a size", () => {
    expect(normalisedSpec({ ...empty, size: "20x20" })).toEqual({ ...empty, size: "20x20" });
  });
});

describe("copyTargets", () => {
  const pool = (id: string, maps: number): MapPool => ({
    id,
    name: id,
    mapIds: Array.from({ length: maps }, (_, index) => `${id}m${index}`),
    sequence: [],
    bestOf: 3,
    published: false,
    publishAt: null,
  });

  it("offers only pools with as many maps, never the source itself", () => {
    const source = pool("a", 4);
    const { eligible, other } = copyTargets(source, [source, pool("b", 4), pool("c", 5)]);
    expect(eligible.map((held) => held.id)).toEqual(["b"]);
    expect(other.map((held) => held.id)).toEqual(["c"]);
  });
});
