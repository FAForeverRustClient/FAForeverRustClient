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
        // A new report starts without a log: the excerpt was read for the
        // previous one, and attaching it is the user's decision each time.
        logAttachment: { type: "off" },
      };
    case "closed":
      return {
        open: false,
        playerId: null,
        login: "",
        status: { type: "idle" },
        history: [],
        historyStatus: { type: "idle" },
        logAttachment: { type: "off" },
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
    case "logPreparing":
      return {
        ...state,
        logAttachment: { type: "preparing", payload: { gameId: event.payload.gameId } },
      };
    case "logPrepared":
      return {
        ...state,
        logAttachment: { type: "ready", payload: { excerpt: event.payload.excerpt } },
      };
    case "logUnavailable":
      return {
        ...state,
        logAttachment: { type: "unavailable", payload: { gameId: event.payload.gameId } },
      };
    case "logFailed":
      return {
        ...state,
        logAttachment: {
          type: "failed",
          payload: { gameId: event.payload.gameId, reason: event.payload.reason },
        },
      };
    case "logDetached":
      return { ...state, logAttachment: { type: "off" } };
  }
}
