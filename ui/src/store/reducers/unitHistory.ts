import type { UnitHistoryEvent, UnitHistoryState, UnitHistoryStatus } from "../../ipc/bindings";

/** Twin of `faf_domain::state::unit_history::MAX_SELECTED`. */
export const MAX_SELECTED_UNITS = 6;

/** Twin of `normalized_selection`: upper case, each unit once, capped. */
export function normalizedSelection(ids: readonly string[]): string[] {
  const selection: string[] = [];
  for (const raw of ids) {
    const id = raw.trim().toUpperCase();
    if (id && !selection.includes(id) && selection.length < MAX_SELECTED_UNITS) selection.push(id);
  }
  return selection;
}

const isSelected = (state: UnitHistoryState, id: string) => state.selected.includes(id);

/** Twin of `faf_domain::state::unit_history::reduce`. */
export function reduceUnitHistory(state: UnitHistoryState, event: UnitHistoryEvent): UnitHistoryState {
  switch (event.type) {
    case "listLoading":
      return { ...state, listStatus: { type: "loading" } };
    case "listLoaded":
      return { ...state, units: event.payload.units, listStatus: { type: "ready" } };
    case "listFailed":
      return { ...state, listStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "selectionChanged": {
      const selected = normalizedSelection(event.payload.ids);
      const histories: Record<string, UnitHistoryStatus> = {};
      for (const [id, status] of Object.entries(state.histories)) {
        if (selected.includes(id)) histories[id] = status;
      }
      return { ...state, selected, histories };
    }
    case "historyProgress": {
      const { id, fetched, total } = event.payload;
      if (!isSelected(state, id)) return state;
      return { ...state, histories: { ...state.histories, [id]: { type: "loading", payload: { fetched, total } } } };
    }
    case "historyLoaded": {
      // A history that arrives after its unit was put away is not kept.
      const history = event.payload.history;
      if (!isSelected(state, history.unit.id)) return state;
      return { ...state, histories: { ...state.histories, [history.unit.id]: { type: "ready", payload: { history } } } };
    }
    case "historyFailed": {
      const { id, reason } = event.payload;
      if (!isSelected(state, id)) return state;
      return { ...state, histories: { ...state.histories, [id]: { type: "failed", payload: { reason } } } };
    }
  }
}
