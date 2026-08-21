import type { LobbyEvent, LobbyState, MatchmakerQueue } from "../../ipc/bindings";

/**
 * Twin of `faf_domain::state::lobby::merge_matchmaker_queues`.
 *
 * The lobby server pushes only the queues whose numbers changed, so a
 * `matchmaker_info` payload is a partial update rather than a snapshot.
 * Replacing the list made queues flicker in and out of the tab.
 */
export function mergeMatchmakerQueues(
  known: MatchmakerQueue[],
  incoming: MatchmakerQueue[],
): MatchmakerQueue[] {
  const merged = [...known];
  for (const queue of incoming) {
    const index = merged.findIndex((existing) => existing.queueName === queue.queueName);
    if (index === -1) merged.push(queue);
    else merged[index] = queue;
  }
  // Stable order: the server's push order is not, and cards must not reshuffle
  // under the cursor. Code-unit comparison rather than `localeCompare`, to
  // match Rust's `String::cmp` exactly; the conformance fixture compares the
  // two orderings directly.
  return merged.sort(
    (left, right) =>
      left.teamSize - right.teamSize
      || (left.queueName < right.queueName ? -1 : left.queueName > right.queueName ? 1 : 0),
  );
}

export function reduceLobby(state: LobbyState, event: LobbyEvent): LobbyState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: "connecting" };
    case "connected":
      return { ...state, status: "connected" };
    // Another tab asked for the host dialog; the Play tab opens it when it sees
    // this and clears it on close.
    case "hostPrepared":
      return { ...state, hostPrefill: event.payload.title };
    case "hostPrefillCleared":
      return { ...state, hostPrefill: null };
    case "hostRequested":
      return { ...state, pendingHostMap: event.payload.map };
    case "gamesUpdated":
      return { ...state, games: event.payload.games };
    case "liveGamesUpdated":
      return { ...state, liveGames: event.payload.games };
    case "matchmakerQueuesUpdated":
      return { ...state, matchmakerQueues: mergeMatchmakerQueues(state.matchmakerQueues, event.payload.queues) };
    case "matchmakingUpdated":
      return { ...state, matchmaking: event.payload.state };
    case "partyUpdated":
      return { ...state, party: event.payload.party };
    case "vetoesUpdated":
      return { ...state, vetoes: event.payload.vetoes };
    case "playModeChanged":
      return { ...state, playMode: event.payload.mode };
    case "avatarsLoading":
      return {
        ...state,
        avatarListStatus: "loading",
        avatarListError: "",
        avatarSelectionStatus: "idle",
        avatarSelectionError: "",
      };
    case "avatarsLoaded":
      return {
        ...state,
        availableAvatars: event.payload.avatars,
        avatarListStatus: "ready",
        avatarListError: "",
      };
    case "avatarsLoadFailed":
      return { ...state, avatarListStatus: "failed", avatarListError: event.payload.reason };
    case "avatarSelectionStarted":
      return { ...state, avatarSelectionStatus: "loading", avatarSelectionError: "" };
    case "avatarSelectionSucceeded":
      return { ...state, avatarSelectionStatus: "ready", avatarSelectionError: "" };
    case "avatarSelectionFailed":
      return {
        ...state,
        avatarSelectionStatus: "failed",
        avatarSelectionError: event.payload.reason,
      };
    case "joining":
      return {
        ...state,
        join: {
          type: "joining",
          payload: { id: event.payload.id, prepared: event.payload.prepared },
        },
      };
    case "launching":
      return { ...state, join: { type: "launched", payload: { launch: event.payload.launch } } };
    case "preparing":
      return {
        ...state,
        join: {
          type: "preparing",
          payload: { detail: event.payload.detail, progress: event.payload.progress },
        },
      };
    case "joinFailed":
      return {
        ...state,
        join: { type: "failed", payload: { id: event.payload.id, reason: event.payload.reason } },
      };
    case "joinCancelled":
      return state.join.type === "joining" || state.join.type === "preparing"
        ? { ...state, join: { type: "idle" } }
        : state;
    case "inGame":
      return { ...state, join: { type: "inGame" } };
    case "launchFailed":
      return { ...state, join: { type: "launchFailed", payload: { reason: event.payload.reason } } };
    // Not cleared on `launching`: the launcher reads it after that event goes
    // out, which is the whole point of keeping it.
    case "gameTerminated":
      return { ...state, join: { type: "idle" }, pendingHostMap: null };
    case "disconnected":
      return {
        ...state,
        status: "disconnected",
        games: [],
        liveGames: [],
        join: { type: "idle" },
        matchmakerQueues: [],
        matchmaking: { type: "idle" },
        party: { ownerId: null, members: [] },
        vetoes: [],
        availableAvatars: [],
        avatarListStatus: "idle",
        avatarListError: "",
        avatarSelectionStatus: "idle",
        avatarSelectionError: "",
        pendingHostMap: null,
      };
  }
}
