// The unfiltered queries are hand-written twins of Rust defaults, and the
// filter UIs compare against them to tell whether anything is filtered. The
// store's initial state is generated from `AppState::default()`, so it holds
// the Rust value of each one: a drift fails here rather than shipping.

import { describe, expect, it } from "vitest";
import { INITIAL_STATE } from "../ipc/initialState";
import { EMPTY_REPLAY_QUERY } from "./replayQuery";
import { EMPTY_TRAINING_QUERY } from "./trainingQuery";
import { EMPTY_MAP_QUERY, EMPTY_MOD_QUERY } from "./vaultQuery";

describe("unfiltered queries match AppState::default()", () => {
  it.each([
    ["EMPTY_MAP_QUERY", EMPTY_MAP_QUERY, INITIAL_STATE.maps.browseQuery],
    ["EMPTY_MOD_QUERY", EMPTY_MOD_QUERY, INITIAL_STATE.mods.browseQuery],
    ["EMPTY_REPLAY_QUERY", EMPTY_REPLAY_QUERY, INITIAL_STATE.replays.vaultQuery],
    ["EMPTY_TRAINING_QUERY", EMPTY_TRAINING_QUERY, INITIAL_STATE.training.query],
  ] as const)("%s", (_name, twin, generated) => {
    expect(twin).toEqual(generated);
  });
});
