// The frontend twin of the replay detail reads in
// `faf_domain::state::replays::reduce`.
//
// A reader who opens one replay's insights and then another's has two reads in
// flight at once, and they finish in whatever order the files allow. The store
// holds one analysis and one error per kind, so these pin that only the newest
// request's answer lands there and that every error says whose it is.

import { describe, expect, it } from "vitest";
import type { ReplayAnalysis, ReplayEvent, ReplayState } from "../../ipc/bindings";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { reduceReplays } from "./replays";

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
    detailsLoading: null,
    detailsError: null,
    analysis: null,
    analysisLoading: null,
    analysisError: null,
    onlineLookups: {},
    resolvedMaps: {},
    recentMatchmaker: [],
    recentMatchmakerStatus: { type: "idle" },
  };
}

function analysis(uid: number): ReplayAnalysis {
  return {
    uid,
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

const details = { gameOptions: [], chatMessages: [], gameVersion: null };

const run = (events: ReplayEvent[], from: ReplayState = state()) => events.reduce(reduceReplays, from);

describe("replay analysis requests", () => {
  it("never lets a late analysis replace the newer request's answer", () => {
    const after = run([
      { type: "analysisLoading", payload: { uid: 1 } },
      { type: "analysisLoading", payload: { uid: 2 } },
      { type: "analysisLoaded", payload: { analysis: analysis(2) } },
      { type: "analysisLoaded", payload: { analysis: analysis(1) } },
    ]);
    expect(after.analysis?.uid).toBe(2);
    expect(after.analysisLoading).toBeNull();
  });

  it("keeps the newer request loading when the older answer lands first", () => {
    const early = run([
      { type: "analysisLoading", payload: { uid: 1 } },
      { type: "analysisLoading", payload: { uid: 2 } },
      { type: "analysisLoaded", payload: { analysis: analysis(1) } },
    ]);
    expect(early.analysis).toBeNull();
    expect(early.analysisLoading).toBe(2);

    const after = run([{ type: "analysisLoaded", payload: { analysis: analysis(2) } }], early);
    expect(after.analysis?.uid).toBe(2);
    expect(after.analysisLoading).toBeNull();
  });

  it("never shows a late analysis failure for the newer request", () => {
    const answered = run([
      { type: "analysisLoading", payload: { uid: 1 } },
      { type: "analysisLoading", payload: { uid: 2 } },
      { type: "analysisLoaded", payload: { analysis: analysis(2) } },
      { type: "analysisFailed", payload: { uid: 1, reason: "the replay file could not be read" } },
    ]);
    expect(answered.analysisError).toBeNull();
    expect(answered.analysis?.uid).toBe(2);

    const pending = run([
      { type: "analysisLoading", payload: { uid: 1 } },
      { type: "analysisLoading", payload: { uid: 2 } },
      { type: "analysisFailed", payload: { uid: 1, reason: "late" } },
    ]);
    expect(pending.analysisError).toBeNull();
    expect(pending.analysisLoading).toBe(2);

    const failed = run([{ type: "analysisFailed", payload: { uid: 2, reason: "truncated" } }], pending);
    expect(failed.analysisError).toEqual({ uid: 2, reason: "truncated" });
    expect(failed.analysisLoading).toBeNull();
  });
});

describe("replay details requests", () => {
  it("never shows a late details failure for the newer request", () => {
    const after = run([
      { type: "detailsLoading", payload: { uid: 1 } },
      { type: "detailsLoading", payload: { uid: 2 } },
      { type: "detailsLoaded", payload: { uid: 2, details } },
      { type: "detailsFailed", payload: { uid: 1, reason: "the replay body is truncated" } },
    ]);
    expect(after.detailsError).toBeNull();
    expect(after.replayDetails?.[2]).toEqual(details);
    expect(after.detailsLoading).toBeNull();
  });

  it("keeps the newer request's failure when an older answer lands after it", () => {
    const after = run([
      { type: "detailsLoading", payload: { uid: 1 } },
      { type: "detailsLoading", payload: { uid: 2 } },
      { type: "detailsFailed", payload: { uid: 2, reason: "not uploaded yet" } },
      { type: "detailsLoaded", payload: { uid: 1, details } },
    ]);
    expect(after.replayDetails?.[1]).toEqual(details);
    expect(after.detailsError).toEqual({ uid: 2, reason: "not uploaded yet" });
  });
});
