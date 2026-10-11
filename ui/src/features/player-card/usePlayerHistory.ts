// The one scan of a player's whole game history, shared by the two tabs that
// read it: the map record and the results list.
//
// The scan is the most expensive thing a profile loads, seventy-odd pages of
// the API for a long history, and each of the two tabs used to start it again
// on every visit. Switching from Maps to Results and back would have read the
// same history three times. So a scan is asked for only when what the state
// holds belongs to somebody else, or the last attempt failed.

import { useCallback, useEffect } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";

/**
 * The player whose scan was last asked for.
 *
 * Module state rather than component state because the two tabs are two
 * components, mounted one at a time. The loading event carries no player, so
 * this is what tells "already loading this one" from "loading somebody else".
 */
let requestedFor: number | null = null;

/**
 * The player whose whole history was asked for. A profile opens on the most
 * recent games (#440); this is what keeps the full scan, once asked for, from
 * being replaced by the short one when the other tab opens.
 */
let fullFor: number | null = null;

/**
 * Ask for `playerId`'s scan: the whole history once it was asked for, the
 * recent games otherwise. The one place both kinds are sent from, so the
 * first load, a retry and "load all" can never disagree about which it is.
 */
function requestScan(playerId: number) {
  requestedFor = playerId;
  const full = fullFor === playerId;
  ipc.send({ kind: "PlayerCard", command: { type: "loadMapStats", payload: full ? { playerId, full } : { playerId } } });
}

export function usePlayerHistory(playerId: number) {
  const stats = useAppStore((state) => state.state.playerCard.mapStats);
  const status = useAppStore((state) => state.state.playerCard.mapStatsStatus);
  const error = useAppStore((state) => state.state.playerCard.mapStatsError);

  // Decided once, when a tab opens or the player changes, from the state as it
  // is at that moment. Deciding on every render would retry a failing scan in
  // a loop; this retries it once per visit, which is what reopening the tab
  // means.
  useEffect(() => {
    const card = useAppStore.getState().state.playerCard;
    const held = requestedFor === playerId
      && (card.mapStatsStatus === "loading"
        || (card.mapStatsStatus === "ready" && card.mapStats?.playerId === playerId));
    if (held) return;
    requestScan(playerId);
  }, [playerId]);

  const loadFull = () => {
    fullFor = playerId;
    requestScan(playerId);
  };

  // The same scan again, on purpose, the whole history if that is what failed.
  // Reopening the tab also retries, but a failed view that only says what went
  // wrong leaves the reader to find that out; the tabs offer this beside the
  // error instead.
  const retry = useCallback(() => requestScan(playerId), [playerId]);

  return {
    stats: stats?.playerId === playerId ? stats : null,
    status,
    error,
    /** Whether what is on screen is the whole history as far as it was asked. */
    full: fullFor === playerId,
    loadFull,
    retry,
  };
}
