// Conformance tests for the frontend lobby reducer, the twin of
// `faf_domain::state::lobby::reduce`.
//
// The join state machine is the part most worth pinning: it drives what the
// Play tab shows during a launch, and a divergence here means the UI claims a
// different launch phase than the backend is in.

import { describe, expect, it } from "vitest";
import type { Game, GameLaunch, LobbyEvent, LobbyState } from "../../ipc/bindings";
import { reduceLobby } from "./lobby";

function state(overrides: Partial<LobbyState> = {}): LobbyState {
  return {
    status: "disconnected",
    games: [],
    liveGames: [],
    join: { type: "idle" },
    matchmakerQueues: [],
    matchmaking: { type: "idle" },
    party: { ownerId: null, members: [] },
    vetoes: [],
    playMode: "custom",
    availableAvatars: [],
    avatarListStatus: "idle",
    avatarListError: "",
    avatarSelectionStatus: "idle",
    avatarSelectionError: "",
    hostPrefill: null,
    ...overrides,
  };
}

function game(id: number): Game {
  return {
    id,
    title: `Game ${id}`,
    host: "Ada",
    players: 1,
    maxPlayers: 8,
    map: "scmp_009",
    modName: "faf",
    averageRating: 1200,
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    teams: {},
    simMods: {},
  };
}

const launch: GameLaunch = {
  uid: 7,
  mod: "faf",
  name: "Game 7",
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

const apply = (initial: LobbyState, ...events: LobbyEvent[]): LobbyState =>
  events.reduce(reduceLobby, initial);

describe("the join state machine", () => {
  it("runs joining → launched → preparing → inGame", () => {
    // Rust: the same four arms. `preparing` is its own phase because patching
    // the featured mod is the only slow step before the game window appears.
    let next = apply(
      state({ status: "connected" }),
      { type: "joining", payload: { id: 7, prepared: false } },
    );
    expect(next.join).toEqual({ type: "joining", payload: { id: 7, prepared: false } });

    next = apply(next, { type: "joining", payload: { id: 7, prepared: true } });
    expect(next.join).toEqual({ type: "joining", payload: { id: 7, prepared: true } });

    next = apply(next, { type: "launching", payload: { launch } });
    expect(next.join).toEqual({ type: "launched", payload: { launch } });

    next = apply(next, { type: "preparing", payload: { detail: "Updating faf", progress: 50 } });
    expect(next.join).toEqual({ type: "preparing", payload: { detail: "Updating faf", progress: 50 } });

    next = apply(next, { type: "inGame" });
    expect(next.join).toEqual({ type: "inGame" });
  });

  it("replaces the preparing detail rather than accumulating it", () => {
    // It is a status line, not a log; the Rust reducer overwrites too.
    const next = apply(
      state(),
      { type: "preparing", payload: { detail: "Updating faf", progress: 25 } },
      { type: "preparing", payload: { detail: "Downloading map", progress: null } },
    );
    expect(next.join).toEqual({
      type: "preparing",
      payload: { detail: "Downloading map", progress: null },
    });
  });

  it("records why a join or a launch failed", () => {
    expect(
      apply(state(), { type: "joinFailed", payload: { id: 7, reason: "closed" } }).join,
    ).toEqual({ type: "failed", payload: { id: 7, reason: "closed" } });

    expect(apply(state(), { type: "launchFailed", payload: { reason: "503" } }).join).toEqual({
      type: "launchFailed",
      payload: { reason: "503" },
    });
  });

  it("cancels only a pending join", () => {
    const pending = state({ join: { type: "joining", payload: { id: 7, prepared: true } } });
    expect(apply(pending, { type: "joinCancelled" }).join).toEqual({ type: "idle" });

    const running = state({ join: { type: "inGame" } });
    expect(apply(running, { type: "joinCancelled" })).toBe(running);
  });
});

describe("disconnect", () => {
  it("clears everything the connection owned", () => {
    // Rust clears exactly this set. Anything left behind is stale data the UI
    // would keep rendering for a server we are no longer talking to.
    const connected = state({
      status: "connected",
      games: [game(1)],
      liveGames: [game(2)],
      join: { type: "inGame" },
      matchmakerQueues: [{ queueName: "ladder1v1", teamSize: 1, numPlayers: 4, queuePopTimeSeconds: 30 }],
      matchmaking: { type: "searching", payload: { queueNames: ["ladder1v1"] } },
      party: { ownerId: 7, members: [{ playerId: 7, name: "Ada", factions: [] }] },
      vetoes: [{ matchmakerQueueMapPoolId: 1, mapPoolMapVersionId: 2, vetoTokensApplied: 1 }],
    });

    const next = apply(connected, { type: "disconnected" });
    expect(next).toEqual(
      state({
        status: "disconnected",
        // playMode deliberately survives: it is a UI preference, not
        // connection state, and resetting it would bounce the user out of the
        // tab they were on.
        playMode: "custom",
      }),
    );
  });

  it("keeps the selected play mode", () => {
    const next = apply(state({ status: "connected", playMode: "matchmaking" }), {
      type: "disconnected",
    });
    expect(next.playMode).toBe("matchmaking");
  });
});

describe("snapshots", () => {
  it("replaces the game lists wholesale", () => {
    // Both are full snapshots in the Rust reducer, not deltas.
    const next = apply(
      state({ games: [game(1), game(2)] }),
      { type: "gamesUpdated", payload: { games: [game(3)] } },
      { type: "liveGamesUpdated", payload: { games: [game(4)] } },
    );
    expect(next.games.map((g) => g.id)).toEqual([3]);
    expect(next.liveGames.map((g) => g.id)).toEqual([4]);
  });
});
