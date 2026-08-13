import type { CoopEvent, CoopState } from "../../ipc/bindings";

export function reduceCoop(state: CoopState, event: CoopEvent): CoopState {
  switch (event.type) {
    case "catalogLoading":
      return { ...state, catalogStatus: { type: "loading" } };
    case "catalogLoaded": {
      // Twin of `faf_domain::state::coop::reduce`: keep the open mission
      // across a refresh, but never point at one that has gone.
      const { scenarios, missions } = event.payload;
      const stillPresent = missions.some((m) => m.id === state.selectedMissionId);
      return {
        ...state,
        scenarios,
        missions,
        catalogStatus: { type: "ready" },
        selectedMissionId: stillPresent ? state.selectedMissionId : (missions[0]?.id ?? null),
      };
    }
    case "catalogLoadFailed":
      return {
        ...state,
        catalogStatus: {
          type: "failed",
          payload: { reason: event.payload.reason, kind: event.payload.kind },
        },
      };
    case "missionSelected":
      // Clear the old times so they cannot sit under the new mission's name
      // while the fresh ones load.
      return { ...state, selectedMissionId: event.payload.missionId, leaderboard: [] };
    case "playerCountChanged":
      return { ...state, playerCount: event.payload.playerCount, leaderboard: [] };
    case "leaderboardLoading":
      return { ...state, leaderboardStatus: { type: "loading" } };
    case "leaderboardLoaded": {
      // Drop a reply that no longer matches what is on screen; clicking
      // through missions can land an older response after a newer one.
      const { missionId, playerCount, results } = event.payload;
      if (state.selectedMissionId !== missionId || state.playerCount !== playerCount) return state;
      return { ...state, leaderboard: results, leaderboardStatus: { type: "ready" } };
    }
    case "leaderboardLoadFailed":
      return {
        ...state,
        leaderboardStatus: {
          type: "failed",
          payload: { reason: event.payload.reason, kind: event.payload.kind },
        },
      };
  }
}
