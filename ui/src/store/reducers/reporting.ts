import type { ReportingEvent, ReportingState } from "../../ipc/bindings";

export function reduceReporting(state: ReportingState, event: ReportingEvent): ReportingState {
  switch (event.type) {
    case "opened":
      return {
        ...state,
        open: true,
        playerId: event.payload.playerId,
        login: event.payload.login,
        status: { type: "idle" },
      };
    case "closed":
      return {
        open: false,
        playerId: null,
        login: "",
        status: { type: "idle" },
        history: [],
        historyStatus: { type: "idle" },
      };
    case "submitting":
      return { ...state, status: { type: "submitting" } };
    case "submitted":
      return { ...state, status: { type: "submitted" } };
    case "failed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "historyLoading":
      return { ...state, historyStatus: { type: "loading" } };
    case "historyLoaded":
      return { ...state, history: event.payload.reports, historyStatus: { type: "ready" } };
    case "historyFailed":
      return {
        ...state,
        historyStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
  }
}
