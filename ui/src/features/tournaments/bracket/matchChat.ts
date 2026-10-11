// Opening a match's chat from wherever the match is shown: the bracket, the
// Swiss rounds, the Vetoes tab and a match's details, as on the website.
//
// A context rather than a prop, because the button lives in `MatchActions`,
// four components down from the pane that owns the chat, and every one of
// them would otherwise pass along a callback it never uses.

import { createContext } from "react";
import type { Tourney, TourneyMatch } from "../../../ipc/bindings";
import { BYE } from "./swissRecords";

export interface MatchChatApi {
  open: (entry: TourneyMatch) => void;
  /** Unread posts in the match's room, where the room list is loaded. */
  unread: (entry: TourneyMatch) => number;
}

export const MatchChatContext = createContext<MatchChatApi | null>(null);

/** The service's room id for a match. */
export function matchRoomId(entry: TourneyMatch): string {
  return `match:${entry.id}`;
}

/**
 * Whether this account may open the match's chat: an organiser, a caster, or
 * a member of either side, once both sides are real. The website's
 * `matchChatAllowed`, and the service's own rule for match rooms.
 */
export function mayOpenMatchChat(event: Tourney, entry: TourneyMatch): boolean {
  if (entry.bracket === "freeForAll") return false;
  if (entry.team1 === null || entry.team2 === null || entry.team1 === BYE || entry.team2 === BYE) {
    return false;
  }
  if (event.viewer.organiser || event.viewer.caster) return true;
  const mine = event.viewer.memberTeamId;
  return mine !== null && (entry.team1 === mine || entry.team2 === mine);
}
