import type { TourneyEvent, TourneyState } from "../../ipc/bindings";

/// Twin of `faf_domain::state::tourney::reduce`. Every branch below mirrors one
/// there; the conformance fixture replays the same events through both and
/// compares the resulting slice, so a change on either side has to be made on
/// both.

/** Forget everything that belonged to the event that was open. */
function clearOpenEvent(state: TourneyState): TourneyState {
  return {
    ...state,
    detail: null,
    detailStatus: { type: "idle" },
    entrantProfiles: [],
    chatRooms: [],
    chatPosts: [],
    openRoomId: null,
    chatStatus: { type: "idle" },
  };
}

export function reduceTourney(state: TourneyState, event: TourneyEvent): TourneyState {
  switch (event.type) {
    case "loading":
      return { ...state, status: { type: "loading" } };
    case "loaded": {
      // Keep the open event across a refresh, but never leave a selection
      // pointing at a tournament that has gone.
      const { events } = event.payload;
      const stillPresent = events.some((held) => held.id === state.selectedId);
      if (stillPresent) {
        return { ...state, events, status: { type: "ready" } };
      }
      return {
        ...clearOpenEvent(state),
        events,
        status: { type: "ready" },
        selectedId: events[0]?.id ?? null,
      };
    }
    case "loadFailed":
      return {
        ...state,
        status: {
          type: "failed",
          payload: { reason: event.payload.reason, kind: event.payload.kind },
        },
      };
    case "selected": {
      const { tournamentId } = event.payload;
      if (state.selectedId === tournamentId) return state;
      // Drop the previous event's bracket and conversation at once, rather
      // than letting them linger under the new heading until the reload lands.
      return { ...clearOpenEvent(state), selectedId: tournamentId };
    }
    case "detailLoading":
      return { ...state, detailStatus: { type: "loading" } };
    case "detailLoaded": {
      const detail = event.payload.event;
      // A detail for an event the reader already left is discarded; the
      // service's generation token makes this rare, not impossible.
      if (state.selectedId !== detail.id) return state;
      return {
        ...state,
        detail,
        detailStatus: { type: "ready" },
        // The row and the detail must not disagree about the entrant count or
        // the status.
        events: state.events.map((row) => (row.id === detail.id ? detail : row)),
      };
    }
    case "detailLoadFailed":
      return {
        ...state,
        detailStatus: {
          type: "failed",
          payload: { reason: event.payload.reason, kind: event.payload.kind },
        },
      };
    case "actionStarted":
      return { ...state, pending: event.payload.action, actionError: null };
    case "actionSucceeded": {
      const { select } = event.payload;
      if (select === null) return { ...state, pending: null, actionError: null };
      // A newly created event. Its detail has not been fetched yet, so the
      // previous one goes with the selection or it would sit under the new
      // name until the reload lands.
      return { ...clearOpenEvent(state), pending: null, actionError: null, selectedId: select };
    }
    case "actionFailed":
      return { ...state, pending: null, actionError: event.payload.failure };
    case "actionErrorDismissed":
      return { ...state, actionError: null };
    case "entrantProfilesLoaded":
      return { ...state, entrantProfiles: event.payload.profiles };
    case "chatRoomsLoaded": {
      const { rooms } = event.payload;
      // An open room that no longer exists would leave posts on screen with
      // nothing to reload them from.
      const stillOpen = rooms.some((room) => room.id === state.openRoomId);
      if (stillOpen) return { ...state, chatRooms: rooms };
      return { ...state, chatRooms: rooms, openRoomId: null, chatPosts: [] };
    }
    case "roomOpened": {
      const { roomId } = event.payload;
      if (state.openRoomId === roomId) return { ...state, openRoomId: roomId };
      return { ...state, openRoomId: roomId, chatPosts: [] };
    }
    case "chatLoading":
      return { ...state, chatStatus: { type: "loading" } };
    case "chatLoaded": {
      const { roomId, posts } = event.payload;
      if (state.openRoomId !== roomId) return state;
      return {
        ...state,
        chatPosts: posts,
        chatStatus: { type: "ready" },
        // Reading a room is what clears its unread marker server-side, so the
        // badge goes here too rather than waiting for the next room list.
        chatRooms: state.chatRooms.map((room) =>
          room.id === roomId ? { ...room, unread: 0 } : room,
        ),
      };
    }
    case "chatFailed":
      return {
        ...state,
        chatStatus: {
          type: "failed",
          payload: { reason: event.payload.reason, kind: event.payload.kind },
        },
      };
    case "articlesLoaded":
      return { ...state, articles: event.payload.articles };
    case "hostingLoaded":
      return { ...state, hosting: event.payload.hosting };
  }
}
