import { describe, expect, it } from "vitest";
import type { MatchmakerQueue } from "../../../ipc/bindings";
import { playersPerMatch } from "./queueExplainer";

function queue(overrides: Partial<MatchmakerQueue> = {}): MatchmakerQueue {
  return {
    queueName: "tmm4v4",
    teamSize: 4,
    numPlayers: 0,
    queuePopTimeSeconds: 60,
    boundary80s: [],
    boundary75s: [],
    ...overrides,
  };
}

describe("how many players a queue needs", () => {
  it("is twice the team size", () => {
    // Half the answer to "eight people are queued for 3v3, why is nothing
    // happening": six of the eight would be a game, and eight is two short of
    // two games. The other half is whether those six split evenly, which no
    // count can show.
    expect(playersPerMatch(queue({ teamSize: 1 }))).toBe(2);
    expect(playersPerMatch(queue({ teamSize: 3 }))).toBe(6);
    expect(playersPerMatch(queue({ teamSize: 4 }))).toBe(8);
  });
});
