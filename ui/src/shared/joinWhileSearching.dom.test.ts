// @vitest-environment happy-dom
//
// A join asked for during a matchmaker search waits for the player to choose
// between the search and the lobby (#650).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppCommand, MatchmakingState } from "../ipc/bindings";
import { clearSentCommands, seedStore, sentCommands } from "../testing/mounted";
import { joinGame, stopSearchingAndJoin } from "./joinGame";
import { activeSearchQueues, searchJoinSnapshot, setSearchJoin } from "./joinWhileSearching";

vi.mock("../ipc/client");

afterEach(() => {
  setSearchJoin(null);
  clearSentCommands();
});

function withMatchmaking(matchmaking: MatchmakingState) {
  seedStore((state) => ({ ...state, lobby: { ...state.lobby, matchmaking } }));
}

const lobbyCommands = () =>
  sentCommands().flatMap((command: AppCommand) => (command.kind === "Lobby" ? [command.command] : []));

describe("joining a lobby during a matchmaker search", () => {
  it("asks first, and sends nothing until answered", async () => {
    withMatchmaking({ type: "searching", payload: { queueNames: ["ladder1v1", "tmm2v2"] } });
    await joinGame(42, "secret");
    expect(searchJoinSnapshot()).toEqual({ id: 42, title: "", password: "secret", queueNames: ["ladder1v1", "tmm2v2"] });
    expect(lobbyCommands()).toEqual([]);
  });

  it("leaves every queue before the join goes out", async () => {
    withMatchmaking({ type: "searching", payload: { queueNames: ["ladder1v1", "tmm2v2"] } });
    await stopSearchingAndJoin(42, null, ["ladder1v1", "tmm2v2"]);
    expect(lobbyCommands()).toEqual([
      { type: "matchmake", payload: { queueName: "ladder1v1", start: false } },
      { type: "matchmake", payload: { queueName: "tmm2v2", start: false } },
      { type: "join", payload: { id: 42, password: null, replaceMods: false } },
    ]);
    expect(searchJoinSnapshot()).toBeNull();
  });

  it("joins straight away when nothing is being searched for", async () => {
    withMatchmaking({ type: "idle" });
    await joinGame(42);
    expect(searchJoinSnapshot()).toBeNull();
    expect(lobbyCommands()).toEqual([{ type: "join", payload: { id: 42, password: null, replaceMods: false } }]);
  });

  it("counts a search still getting ready, but not a match already found", () => {
    expect(activeSearchQueues({ type: "preparing", payload: { queueNames: ["ladder1v1"] } })).toEqual(["ladder1v1"]);
    expect(activeSearchQueues({ type: "matchFound", payload: { queueName: "ladder1v1" } })).toEqual([]);
    expect(activeSearchQueues({ type: "launching", payload: { queueName: "ladder1v1" } })).toEqual([]);
  });
});
