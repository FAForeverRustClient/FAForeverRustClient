import { describe, expect, it } from "vitest";
import { hideGlobalLineup, setGlobalLineup, getActiveLineupSnapshot } from "./CustomGamesBrowser";

describe("CustomGamesBrowser global lineup tooltip state", () => {
  it("sets active lineup position for a specific game", () => {
    setGlobalLineup(1001, { left: 100, top: 200 });
    expect(getActiveLineupSnapshot()).toEqual({
      gameId: 1001,
      position: { left: 100, top: 200 },
    });
  });

  it("enforces mutual exclusion: opening game 2 closes game 1", () => {
    setGlobalLineup(1001, { left: 100, top: 200 });
    expect(getActiveLineupSnapshot()?.gameId).toBe(1001);

    setGlobalLineup(1002, { left: 150, top: 250 });
    expect(getActiveLineupSnapshot()?.gameId).toBe(1002);
  });

  it("hides global lineup completely", () => {
    setGlobalLineup(1003, { left: 50, top: 50 });
    expect(getActiveLineupSnapshot()?.gameId).toBe(1003);

    hideGlobalLineup();
    expect(getActiveLineupSnapshot()).toBeNull();
  });
});
