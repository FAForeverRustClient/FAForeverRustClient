// Twin of `faf_domain::state::clan::reduce`. Pinned by the conformance
// fixture, not by anyone's reading of the Rust.

import type { ClanEvent, ClanIdentity, ClanState } from "../../ipc/bindings";

const EMPTY_IDENTITY: ClanIdentity = {
  playerId: 0,
  login: "",
  clanId: "",
  clanName: "",
  clanTag: "",
  isLeader: false,
};

const EMPTY: ClanState = {
  identity: EMPTY_IDENTITY,
  status: { type: "idle" },
  clan: null,
  action: { type: "idle" },
  candidates: [],
  invitation: null,
};

export { EMPTY as EMPTY_CLAN_STATE };

/** Twin of `ClanIdentity::in_a_clan`. */
export const inAClan = (identity: ClanIdentity) => identity.clanId !== "";

export function reduceClan(state: ClanState, event: ClanEvent): ClanState {
  switch (event.type) {
    case "loading":
      return { ...state, status: { type: "loading" } };
    case "loaded": {
      const { identity, clan } = event.payload;
      const next: ClanState = {
        ...state,
        identity,
        clan: clan ?? null,
        status: { type: "ready" },
      };
      // A reload follows every write, so this is also where a finished action
      // stops being announced: leaving the banner up over the result it
      // produced reads as though it were still happening.
      if (next.action.type === "succeeded") next.action = { type: "idle" };
      if (!inAClan(identity)) {
        next.invitation = null;
        next.candidates = [];
      }
      return next;
    }
    case "loadFailed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "actionStarted":
      return { ...state, action: { type: "working", payload: { action: event.payload.action } } };
    case "actionFailed":
      return {
        ...state,
        action: {
          type: "failed",
          payload: {
            action: event.payload.action,
            reason: event.payload.reason,
            kind: event.payload.kind,
          },
        },
      };
    case "actionSucceeded":
      return { ...state, action: { type: "succeeded", payload: { action: event.payload.action } } };
    case "candidatesLoaded":
      return { ...state, candidates: event.payload.candidates };
    case "invitationReady":
      // The field has done its job; leaving the list open invites a second
      // click that would replace the token just generated.
      return { ...state, invitation: event.payload.invitation, candidates: [] };
    case "invitationCleared":
      return { ...state, invitation: null };
  }
}
