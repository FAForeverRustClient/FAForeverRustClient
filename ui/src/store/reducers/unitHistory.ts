import type { UnitHistoryEvent, UnitHistoryState, UnitHistoryStatus } from "../../ipc/bindings";

const isShown = (state: UnitHistoryState, id: string) => state.selected === id || state.compared === id;

/** Only the unit on screen and the one it is compared with keep a history. */
function keepOnlyShown(state: UnitHistoryState): UnitHistoryState {
  const histories: Record<string, UnitHistoryStatus> = {};
  for (const [id, status] of Object.entries(state.histories)) {
    if (isShown(state, id)) histories[id] = status;
  }
  return { ...state, histories };
}

/** Twin of `faf_domain::state::unit_history::reduce`. */
export function reduceUnitHistory(state: UnitHistoryState, event: UnitHistoryEvent): UnitHistoryState {
  switch (event.type) {
    case "listLoading":
      return { ...state, listStatus: { type: "loading" } };
    case "listLoaded":
      return { ...state, units: event.payload.units, listStatus: { type: "ready" } };
    case "listFailed":
      return { ...state, listStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "selected": {
      const id = event.payload.id;
      return keepOnlyShown({ ...state, selected: id, compared: state.compared === id ? null : state.compared });
    }
    case "compared": {
      const id = event.payload.id;
      return keepOnlyShown({ ...state, compared: id !== null && id !== state.selected ? id : null });
    }
    case "historyProgress": {
      const { id, fetched, total } = event.payload;
      if (!isShown(state, id)) return state;
      return { ...state, histories: { ...state.histories, [id]: { type: "loading", payload: { fetched, total } } } };
    }
    case "historyLoaded": {
      // A history that arrives after the choice has moved on is not kept.
      const history = event.payload.history;
      if (!isShown(state, history.unit.id)) return state;
      return { ...state, histories: { ...state.histories, [history.unit.id]: { type: "ready", payload: { history } } } };
    }
    case "historyFailed": {
      const { id, reason } = event.payload;
      if (!isShown(state, id)) return state;
      return { ...state, histories: { ...state.histories, [id]: { type: "failed", payload: { reason } } } };
    }
  }
}
