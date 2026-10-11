// The frontend twin of the replay detail reads in
// `faf_domain::state::replays::reduce`.
//
// A reader who opens one replay's insights and then another's has two reads in
// flight at once, and they finish in whatever order the files allow. The store
// holds one analysis and one error per kind, so these pin that only the newest
// request's answer lands there and that every error says whose it is.
//
// Every read is named by its read key, not by the game id: a file whose header
// names no game is uid 0, like every other such file, and only its path tells
// two of them apart.

import { describe, expect, it } from "vitest";
import type { ReplayAnalysis, ReplayDetails, ReplayEvent, ReplayState, VaultReplay } from "../../ipc/bindings";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { replayReadKey } from "../../shared/rules/replayReadKey";
import { ONLINE_LOOKUPS_KEPT, REPLAY_DETAILS_KEPT, RESOLVED_MAPS_KEPT, reduceReplays } from "./replays";

function state(): ReplayState {
  return {
    status: { type: "idle" },
    lastWarning: null,
    preparing: null,
    liveTracking: null,
    vault: [],
    vaultStatus: { type: "idle" },
    vaultQuery: EMPTY_REPLAY_QUERY,
    vaultHasMore: false,
    vaultTotalPages: null,
    vaultTotalRecords: null,
    downloadStatus: { type: "idle" },
    featuredMods: [],
    local: [],
    localStatus: { type: "idle" },
    replayDetails: {},
    replayDetailsOrder: [],
    detailsLoading: null,
    detailsError: null,
    analysis: null,
    analysisLoading: null,
    analysisError: null,
    onlineLookups: {},
    onlineLookupsOrder: [],
    resolvedMaps: {},
    resolvedMapsOrder: [],
    recentMatchmaker: [],
    recentMatchmakerStatus: { type: "idle" },
  };
}

/** The read of a vault replay, which its game id names. */
const game = (uid: number) => replayReadKey(uid, null);
/** The read of a file whose header names no game. */
const file = (path: string) => replayReadKey(0, path);

const FILE_A = "C:/replays/skirmish-a.fafreplay";
const FILE_B = "C:/replays/skirmish-b.fafreplay";

function analysis(key: string): ReplayAnalysis {
  return {
    uid: 0,
    key,
    ticks: 3_000,
    gameVersion: "",
    armies: [],
    observers: [],
    scenario: { name: "", description: "", mapFolder: "", width: 0, height: 0, options: [] },
    activity: [],
    orders: [],
    points: [],
    notices: [],
    stats: [],
  };
}

const details: ReplayDetails = { gameOptions: [], chatMessages: [], gameVersion: null };

const analysisLoading = (key: string): ReplayEvent => ({ type: "analysisLoading", payload: { key } });
const analysisLoaded = (key: string): ReplayEvent => ({ type: "analysisLoaded", payload: { analysis: analysis(key) } });
const analysisFailed = (key: string, reason: string): ReplayEvent => ({
  type: "analysisFailed",
  payload: { key, reason },
});
const detailsLoading = (key: string): ReplayEvent => ({ type: "detailsLoading", payload: { key } });
const detailsLoaded = (key: string, answer: ReplayDetails = details): ReplayEvent => ({
  type: "detailsLoaded",
  payload: { key, details: answer },
});
const detailsFailed = (key: string, reason: string): ReplayEvent => ({
  type: "detailsFailed",
  payload: { key, reason },
});

const run = (events: ReplayEvent[], from: ReplayState = state()) => events.reduce(reduceReplays, from);

describe("replay analysis requests", () => {
  it("never lets a late analysis replace the newer request's answer", () => {
    const after = run([
      analysisLoading(game(1)),
      analysisLoading(game(2)),
      analysisLoaded(game(2)),
      analysisLoaded(game(1)),
    ]);
    expect(after.analysis?.key).toBe(game(2));
    expect(after.analysisLoading).toBeNull();
  });

  it("keeps the newer request loading when the older answer lands first", () => {
    const early = run([analysisLoading(game(1)), analysisLoading(game(2)), analysisLoaded(game(1))]);
    expect(early.analysis).toBeNull();
    expect(early.analysisLoading).toBe(game(2));

    const after = run([analysisLoaded(game(2))], early);
    expect(after.analysis?.key).toBe(game(2));
    expect(after.analysisLoading).toBeNull();
  });

  it("never shows a late analysis failure for the newer request", () => {
    const answered = run([
      analysisLoading(game(1)),
      analysisLoading(game(2)),
      analysisLoaded(game(2)),
      analysisFailed(game(1), "the replay file could not be read"),
    ]);
    expect(answered.analysisError).toBeNull();
    expect(answered.analysis?.key).toBe(game(2));

    const pending = run([analysisLoading(game(1)), analysisLoading(game(2)), analysisFailed(game(1), "late")]);
    expect(pending.analysisError).toBeNull();
    expect(pending.analysisLoading).toBe(game(2));

    const failed = run([analysisFailed(game(2), "truncated")], pending);
    expect(failed.analysisError).toEqual({ key: game(2), reason: "truncated" });
    expect(failed.analysisLoading).toBeNull();
  });
});

describe("replay details requests", () => {
  it("never shows a late details failure for the newer request", () => {
    const after = run([
      detailsLoading(game(1)),
      detailsLoading(game(2)),
      detailsLoaded(game(2)),
      detailsFailed(game(1), "the replay body is truncated"),
    ]);
    expect(after.detailsError).toBeNull();
    expect(after.replayDetails?.[game(2)]).toEqual(details);
    expect(after.detailsLoading).toBeNull();
  });

  it("keeps the newer request's failure when an older answer lands after it", () => {
    const after = run([
      detailsLoading(game(1)),
      detailsLoading(game(2)),
      detailsFailed(game(2), "not uploaded yet"),
      detailsLoaded(game(1)),
    ]);
    expect(after.replayDetails?.[game(1)]).toEqual(details);
    expect(after.detailsError).toEqual({ key: game(2), reason: "not uploaded yet" });
  });
});

describe("replay files without a game id", () => {
  const detailsA: ReplayDetails = { ...details, simSeconds: 600 };
  const detailsB: ReplayDetails = { ...details, simSeconds: 1_200 };

  it("are told apart by their paths", () => {
    expect(file(FILE_A)).not.toBe(file(FILE_B));
    // A downloaded copy of a vault game is that game.
    expect(replayReadKey(4242, "C:/replays/4242.fafreplay")).toBe(game(4242));
  });

  it("each keep their own analysis and details, the second opened after the first", () => {
    const afterA = run([
      detailsLoading(file(FILE_A)),
      analysisLoading(file(FILE_A)),
      detailsLoaded(file(FILE_A), detailsA),
      analysisLoaded(file(FILE_A)),
    ]);
    expect(afterA.analysis?.key).toBe(file(FILE_A));

    // B's panel asks for its own reads, and A's analysis is not B's.
    const askingB = run([detailsLoading(file(FILE_B)), analysisLoading(file(FILE_B))], afterA);
    expect(askingB.analysis).toBeNull();
    expect(askingB.analysisLoading).toBe(file(FILE_B));
    expect(askingB.detailsLoading).toBe(file(FILE_B));
    expect(askingB.replayDetails?.[file(FILE_B)]).toBeUndefined();

    const afterB = run([detailsLoaded(file(FILE_B), detailsB), analysisLoaded(file(FILE_B))], askingB);
    expect(afterB.analysis?.key).toBe(file(FILE_B));
    expect(afterB.replayDetails?.[file(FILE_A)]).toEqual(detailsA);
    expect(afterB.replayDetails?.[file(FILE_B)]).toEqual(detailsB);
    expect(afterB.detailsLoading).toBeNull();
    expect(afterB.analysisLoading).toBeNull();
  });

  it("never lets a late answer for one file land for another", () => {
    const pending = run([
      detailsLoading(file(FILE_A)),
      analysisLoading(file(FILE_A)),
      detailsLoading(file(FILE_B)),
      analysisLoading(file(FILE_B)),
      analysisLoaded(file(FILE_A)),
      detailsLoaded(file(FILE_A)),
    ]);
    expect(pending.analysis).toBeNull();
    expect(pending.analysisLoading).toBe(file(FILE_B));
    expect(pending.detailsLoading).toBe(file(FILE_B));
    expect(pending.replayDetails?.[file(FILE_B)]).toBeUndefined();

    const answered = run([analysisLoaded(file(FILE_B)), analysisLoaded(file(FILE_A))], pending);
    expect(answered.analysis?.key).toBe(file(FILE_B));
  });

  it("keeps read failures per file", () => {
    const pending = run([
      detailsLoading(file(FILE_A)),
      analysisLoading(file(FILE_A)),
      detailsLoading(file(FILE_B)),
      analysisLoading(file(FILE_B)),
      detailsFailed(file(FILE_A), "A is truncated"),
      analysisFailed(file(FILE_A), "A is truncated"),
    ]);
    expect(pending.detailsError).toBeNull();
    expect(pending.analysisError).toBeNull();
    expect(pending.detailsLoading).toBe(file(FILE_B));
    expect(pending.analysisLoading).toBe(file(FILE_B));

    const failed = run([
      detailsFailed(file(FILE_B), "B is truncated"),
      analysisFailed(file(FILE_B), "B is truncated"),
      detailsLoaded(file(FILE_A)),
    ], pending);
    expect(failed.detailsError).toEqual({ key: file(FILE_B), reason: "B is truncated" });
    expect(failed.analysisError).toEqual({ key: file(FILE_B), reason: "B is truncated" });
  });
});

describe("stored replay details", () => {
  it("keeps only the most recently stored, dropping the oldest", () => {
    const total = REPLAY_DETAILS_KEPT + 5;
    const after = run(Array.from({ length: total }, (_, index) => detailsLoaded(game(index + 1))));
    expect(Object.keys(after.replayDetails ?? {})).toHaveLength(REPLAY_DETAILS_KEPT);
    expect(after.replayDetailsOrder).toHaveLength(REPLAY_DETAILS_KEPT);
    for (let uid = 1; uid <= 5; uid += 1) expect(after.replayDetails?.[game(uid)]).toBeUndefined();
    expect(after.replayDetailsOrder?.[0]).toBe(game(6));
    expect(after.replayDetailsOrder?.[REPLAY_DETAILS_KEPT - 1]).toBe(game(total));
  });

  it("counts details answered again as stored last", () => {
    const full = run(Array.from({ length: REPLAY_DETAILS_KEPT }, (_, index) => detailsLoaded(game(index + 1))));
    const fresh: ReplayDetails = { ...details, simSeconds: 900 };
    const after = run([detailsLoaded(game(1), fresh), detailsLoaded(game(999))], full);
    expect(after.replayDetails?.[game(1)]).toEqual(fresh);
    expect(after.replayDetails?.[game(2)]).toBeUndefined();
    expect(after.replayDetailsOrder).toHaveLength(REPLAY_DETAILS_KEPT);
  });

  it("stores one file reached through two spellings once", () => {
    const after = run([
      detailsLoaded(file("C:\\Replays\\Skirmish-A.fafreplay")),
      detailsLoaded(file("c:/replays/./skirmish-a.fafreplay")),
    ]);
    expect(after.replayDetailsOrder).toEqual(["path:c:/replays/skirmish-a.fafreplay"]);
  });
});

const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => first + index);
const claimed = (uid: number): ReplayEvent => ({ type: "onlineLookupStarted", payload: { uid } });
const missing = (uid: number): ReplayEvent => ({ type: "onlineLookupFinished", payload: { uid, replay: null } });
const resolved = (uids: number[]): ReplayEvent => ({
  type: "mapsResolved",
  payload: { maps: uids.map((uid) => ({ uid, map: `map_${uid}` })) },
});

function row(uid: number): VaultReplay {
  return {
    uid,
    title: `game ${uid}`,
    map: "",
    mapThumbnailUrl: "",
    modName: "coop",
    startTime: "",
    endTime: "2026-01-01T00:20:00Z",
    replayAvailable: true,
    durationSeconds: null,
    gameDurationSeconds: null,
    teams: [],
    averageRating: null,
    quality: null,
    reviewsAverage: null,
    reviewsCount: null,
    gameVersion: null,
    validity: "",
    victoryCondition: "",
  };
}

// Twins of the cap tests in `faf_domain::state::replays`: the live tab looks up
// every card it shows, and nothing used to take an entry away again.
describe("vault lookups", () => {
  it("keeps only the most recently stored, dropping the oldest", () => {
    const total = ONLINE_LOOKUPS_KEPT + 5;
    const after = run(range(1, total).flatMap((uid) => [claimed(uid), missing(uid)]));
    expect(Object.keys(after.onlineLookups ?? {})).toHaveLength(ONLINE_LOOKUPS_KEPT);
    expect(after.onlineLookupsOrder).toHaveLength(ONLINE_LOOKUPS_KEPT);
    for (const uid of range(1, 5)) expect(after.onlineLookups?.[uid]).toBeUndefined();
    expect(after.onlineLookupsOrder?.[0]).toBe(6);
    expect(after.onlineLookupsOrder?.[ONLINE_LOOKUPS_KEPT - 1]).toBe(total);
  });

  it("counts a lookup answered again as stored last", () => {
    const full = run(range(1, ONLINE_LOOKUPS_KEPT).map(missing));
    const after = run([claimed(1), missing(5_000)], full);
    expect(after.onlineLookups?.[1]).toEqual({ type: "loading" });
    expect(after.onlineLookups?.[2]).toBeUndefined();
  });

  it("keeps every lookup of the largest list of cards, claimed at once", () => {
    const full = run(range(1, ONLINE_LOOKUPS_KEPT).map(missing));
    const cards = range(10_001, 10_400);
    const after = run([...cards.map(claimed), ...cards.map(missing)], full);
    for (const uid of cards) expect(after.onlineLookups?.[uid]).toEqual({ type: "missing" });
  });
});

describe("resolved replay maps", () => {
  it("keeps the newest and never a game of the vault page on screen", () => {
    const onScreen: ReplayState = { ...state(), vault: range(1, 100).map(row) };
    const others = RESOLVED_MAPS_KEPT + 20;
    const after = run(
      [resolved(range(1, 100)), ...range(1_001, 1_000 + others).map((uid) => resolved([uid]))],
      onScreen,
    );
    expect(Object.keys(after.resolvedMaps ?? {})).toHaveLength(RESOLVED_MAPS_KEPT);
    expect(after.resolvedMapsOrder).toHaveLength(RESOLVED_MAPS_KEPT);
    for (const uid of range(1, 100)) expect(after.resolvedMaps?.[uid]).toBe(`map_${uid}`);
    expect(after.resolvedMaps?.[1_001]).toBeUndefined();
    expect(after.resolvedMaps?.[1_000 + others]).toBe(`map_${1_000 + others}`);
  });
});
