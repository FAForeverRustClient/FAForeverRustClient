import { describe, expect, it } from "vitest";
import type { MatchmakerQueue } from "../../../ipc/bindings";
import { secondsUntil } from "./queuePopClock";

function queue(overrides: Partial<MatchmakerQueue> = {}): MatchmakerQueue {
  return {
    queueName: "ladder1v1",
    teamSize: 1,
    numPlayers: 0,
    queuePopTimeSeconds: 42,
    queuePopsAt: "",
    boundary80s: [],
    boundary75s: [],
    ...overrides,
  };
}

describe("the queue pop countdown", () => {
  const popsAt = "2026-10-01T12:00:42.000Z";

  it("counts down to the instant the backend recorded, whenever it is read", () => {
    // The point of the instant: opening the tab a minute after the message
    // arrived does not restart the countdown from the delta.
    expect(secondsUntil(queue({ queuePopsAt: popsAt }), Date.parse("2026-10-01T12:00:00.000Z"))).toBe(42);
    expect(secondsUntil(queue({ queuePopsAt: popsAt }), Date.parse("2026-10-01T12:00:30.500Z"))).toBe(12);
  });

  it("stops at zero rather than going negative", () => {
    expect(secondsUntil(queue({ queuePopsAt: popsAt }), Date.parse("2026-10-01T12:05:00.000Z"))).toBe(0);
  });

  it("falls back to the delta when there is no instant", () => {
    expect(secondsUntil(queue(), Date.parse("2026-10-01T12:00:00.000Z"))).toBe(42);
  });
});
