import { describe, expect, it } from "vitest";
import { match, player, team, tourney } from "./fixtures";
import { hotkeyAction, isMasked, playersLabel, rebind } from "./display";

describe("streamer mode", () => {
  it("hides a finished result until it is revealed, and nothing else", () => {
    const done = match({ id: "m1", status: "done" });
    const ready = match({ id: "m2", status: "ready" });
    expect(isMasked(true, new Set(), done)).toBe(true);
    expect(isMasked(true, new Set(["m1"]), done)).toBe(false);
    expect(isMasked(true, new Set(), ready)).toBe(false);
    expect(isMasked(false, new Set(), done)).toBe(false);
  });
});

describe("show players", () => {
  const event = tourney({
    players: [player({ id: "p1", name: "Ada" }), player({ id: "p2", name: "Bo" })],
    teams: [team({ id: "t1", name: "Blue", playerIds: ["p1", "p2"] }), team({ id: "t2", playerIds: [] })],
  });

  it("names a team by its players, and falls back where it has none", () => {
    expect(playersLabel(event, "t1")).toBe("Ada, Bo");
    expect(playersLabel(event, "t2")).toBeNull();
    expect(playersLabel(event, null)).toBeNull();
  });
});

describe("shortcuts", () => {
  const keys = { players: "f", streamer: "s", playerView: "v" };

  it("answers a single letter or digit, case-insensitively", () => {
    expect(hotkeyAction(keys, "S")).toBe("streamer");
    expect(hotkeyAction(keys, "x")).toBeNull();
    expect(hotkeyAction(keys, "Enter")).toBeNull();
  });

  it("moves a key already in use off its old action", () => {
    expect(rebind(keys, "players", "s")).toEqual({ players: "s", streamer: "", playerView: "v" });
  });
});
