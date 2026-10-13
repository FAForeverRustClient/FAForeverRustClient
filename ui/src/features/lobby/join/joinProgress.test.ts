import { describe, expect, it } from "vitest";
import type { Game, GameLaunch, IceAdapter, JoinState } from "../../../ipc/bindings";
import { adapterNoteOf, contextOf, joinProgressOf, nextStep } from "./joinProgress";

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

  it("stays up while the join waits, before its files and after them", () => {
    // It closed in both and opened again a moment later, its log gone.
    expect(joinProgressOf({ type: "joining", payload: { id: 7, prepared: false } }))
      .toMatchObject({ kind: "preparing", phase: "asking", progress: null });
    expect(joinProgressOf({ type: "joining", payload: { id: 7, prepared: true } }))
      .toEqual({ kind: "seating" });
  });

  it.each<JoinState>([
    { type: "idle" },
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

describe("the adapter line", () => {
  // Every joining setting against a game hosted on Go and one that is not.
  // Java on an unmarked game is nearly every game, and says nothing.
  it.each<[IceAdapter, string, ReturnType<typeof adapterNoteOf>]>([
    ["dynamic", "Friday 4v4 [go-adapter]", "hostOnGo"],
    ["go", "Friday 4v4 [GO-ADAPTER]", "hostOnGo"],
    ["java", "Friday 4v4 [go-adapter]", "javaAgainstHost"],
    ["go", "Friday 4v4", "goAgainstHost"],
    ["dynamic", "Friday 4v4", null],
    ["java", "Friday 4v4", null],
  ])("%s joining \"%s\" is %s", (adapter, title, note) => {
    expect(adapterNoteOf(adapter, title)).toBe(note);
  });
});

describe("what the dialog's head names", () => {
  const label = (map: string) => `label of ${map}`;
  const lobby = { id: 7, title: "Friday 4v4", map: "setons_clutch" } as Game;
  const order = (mapname: string) => ({ uid: 7, name: "Friday 4v4", mapname }) as GameLaunch;

  it("keeps the lobby's map once a custom game's launch order is in, which names none", () => {
    // The head lost its map picture the moment the game started.
    expect(contextOf(order(""), lobby, label)).toEqual({
      name: "Friday 4v4",
      mapName: "setons_clutch",
      detail: "label of setons_clutch",
    });
  });

  it("takes the map a matchmaker launch order names", () => {
    expect(contextOf(order("dualgap"), null, label)?.mapName).toBe("dualgap");
  });

  it("names the lobby before there is a launch order", () => {
    expect(contextOf(null, lobby, label)?.mapName).toBe("setons_clutch");
    expect(contextOf(null, null, label)).toBeNull();
  });
});
