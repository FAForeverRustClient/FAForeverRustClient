import type { TournamentsEvent, TournamentsState } from "../../ipc/bindings";

export function reduceTournaments(
  state: TournamentsState,
  event: TournamentsEvent,
): TournamentsState {
  switch (event.type) {
    case "loading":
      return { ...state, status: { type: "loading" } };
    case "loaded": {
      // Twin of `faf_domain::state::tournaments::reduce`: keep the open detail
      // pane across a refresh, but never point at an event that has gone.
      const { tournaments } = event.payload;
      const stillPresent = tournaments.some((t) => t.id === state.selectedId);
      return {
        ...state,
        tournaments,
        status: { type: "ready" },
        selectedId: stillPresent ? state.selectedId : (tournaments[0]?.id ?? null),
      };
    }
    case "loadFailed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "selected":
      return { ...state, selectedId: event.payload.tournamentId };
  }
}
