import { describe, expect, it } from "vitest";
import type { MatchmakerQueue } from "../../ipc/bindings";
import { queuedPlayerCount } from "./queuedPlayers";

function queue(queueName: string, numPlayers: number): MatchmakerQueue {
  return {
    queueName,
    teamSize: 1,
    numPlayers,
    queuePopTimeSeconds: 60,
    boundary80s: [],
    boundary75s: [],
  };
}

describe("queued player count", () => {
  it("adds up the searches across every queue", () => {
    expect(queuedPlayerCount([queue("ladder1v1", 7), queue("tmm2v2", 4), queue("tmm4v4", 12)])).toBe(23);
  });

  it("is zero when the queues are empty, not the number of queues", () => {
    // The bug this replaces: four published queues drew a "4" whether or not
    // anybody was in them.
    expect(queuedPlayerCount([queue("ladder1v1", 0), queue("tmm2v2", 0)])).toBe(0);
  });

  it("is zero before the lobby has sent any queue at all", () => {
    expect(queuedPlayerCount([])).toBe(0);
  });

  it("ignores a negative count rather than subtracting it", () => {
    expect(queuedPlayerCount([queue("ladder1v1", -3), queue("tmm2v2", 5)])).toBe(5);
  });
});
