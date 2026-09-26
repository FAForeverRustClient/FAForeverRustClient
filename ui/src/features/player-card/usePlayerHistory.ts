// The one scan of a player's whole game history, shared by the two tabs that
// read it: the map record and the results list.
//
// The scan is the most expensive thing a profile loads, seventy-odd pages of
// the API for a long history, and each of the two tabs used to start it again
// on every visit. Switching from Maps to Results and back would have read the
// same history three times. So a scan is asked for only when what the state
// holds belongs to somebody else, or the last attempt failed.

import { useEffect } from "react";
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
    requestedFor = playerId;
    ipc.send({ kind: "PlayerCard", command: { type: "loadMapStats", payload: { playerId } } });
  }, [playerId]);

  return { stats: stats?.playerId === playerId ? stats : null, status, error };
}
