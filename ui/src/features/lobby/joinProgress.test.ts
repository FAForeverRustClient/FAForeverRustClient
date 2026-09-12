import { describe, expect, it } from "vitest";
import type { GameLaunch, JoinState } from "../../ipc/bindings";
import { joinProgressOf, nextStep } from "./joinProgress";

const launch: GameLaunch = {
  uid: 7,
  mod: "faf",
  name: "Seton's, no noobs",
  mapname: "scmp_009",
  gameType: "custom",
  ratingType: "global",
  expectedPlayers: null,
  team: null,
  faction: null,
  mapPosition: null,
  gameOptions: {},
  args: [],
};

describe("what the join dialog shows", () => {
  it("stays on screen while the game is starting, which is the gap reported", () => {
    // Preparation ending used to close the dialog, leaving the seconds it
    // takes Forged Alliance to open a window narrated by one line at the
    // bottom of the client.
    const progress = joinProgressOf({ type: "launched", payload: { launch } });
    expect(progress).toEqual({ kind: "starting", name: "Seton's, no noobs" });
  });

  it("reports the phase and a clamped percentage while preparing", () => {
    expect(joinProgressOf({
      type: "preparing",
      payload: { phase: "downloading", detail: "units.nx2", progress: 42 },
    })).toEqual({ kind: "preparing", phase: "downloading", detail: "units.nx2", progress: 42 });
  });

  it("clamps a percentage outside 0-100 rather than drawing past the bar", () => {
    const over = joinProgressOf({
      type: "preparing",
      payload: { phase: "verifying", detail: "x", progress: 250 },
    });
    expect(over).toMatchObject({ progress: 100 });
  });

  it("treats an absent percentage as an indeterminate bar", () => {
    expect(joinProgressOf({
      type: "preparing",
      payload: { phase: "asking", detail: "", progress: null },
    })).toMatchObject({ progress: null });
  });

  it.each<JoinState>([
    { type: "idle" },
    { type: "joining", payload: { id: 7, prepared: false } },
    { type: "inGame" },
    { type: "failed", payload: { id: 7, reason: "game_full" } },
    { type: "launchFailed", payload: { reason: "adapter did not start" } },
    { type: "needsModReplacement", payload: { id: 7, conflicts: [] } },
  ])("shows nothing for $type", (state) => {
    // In particular `inGame`: the game window is the thing to look at by then,
    // and a failure is kept by the notification centre where it can be read
    // and dismissed instead of covering the client.
    expect(joinProgressOf(state)).toBeNull();
  });
});

describe("the step log", () => {
  it("ignores a repeat of the line already at the end", () => {
    // The backend re-sends one step with a fresh percentage many times over.
    expect(nextStep(["units.nx2"], "units.nx2")).toBeNull();
  });

  it("ignores an empty line", () => {
    expect(nextStep([], "")).toBeNull();
  });

  it("keeps a line that comes back after another one", () => {
    expect(nextStep(["a", "b"], "a")).toBe("a");
  });

  it("takes the first line into an empty log", () => {
    expect(nextStep([], "units.nx2")).toBe("units.nx2");
  });
});
