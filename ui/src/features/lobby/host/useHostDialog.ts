// Which host dialog the Play tab has open and what it opens on: the co-op
// mission a mission's own button asked for, or a title another tab prepared.
// Which of the two dialogs it is follows the play mode, which is the view's.

import { useCallback, useEffect, useState } from "react";
import type { CoopMission } from "../../../ipc/bindings";
import { ipc } from "../../../ipc/client";
import { useAppStore } from "../../../store/store";

export function useHostDialog() {
  const [hostOpen, setHostOpen] = useState(false);
  // Which mission the co-op dialog should open on. `undefined` means "whatever
  // the leaderboard is showing", which is the case when the toolbar button is
  // used rather than a specific mission.
  const [coopMissionToHost, setCoopMissionToHost] = useState<CoopMission | null>(null);
  // A title another tab prepared, e.g. the tournament tab offering to host a
  // bracket match. It lives in the lobby slice because it has to cross a tab
  // boundary; opening the dialog when one arrives is the whole handling.
  const hostPrefill = useAppStore((store) => store.state.lobby.hostPrefill);
  useEffect(() => {
    if (hostPrefill !== null) setHostOpen(true);
  }, [hostPrefill]);

  /** Opens the host dialog, on `mission` when co-op asked for a particular one. */
  const openHostDialog = (mission?: CoopMission) => {
    setCoopMissionToHost(mission ?? null);
    setHostOpen(true);
  };

  // Stable, because the host dialogs are `memo`'d and this is their only
  // prop that is not a store value. A fresh closure per render would hand them
  // a changed prop on every game list the lobby sends, which is the one thing
  // the memo exists to stop.
  const closeHostDialog = useCallback(() => {
    setHostOpen(false);
    setCoopMissionToHost(null);
    // Otherwise the dialog reopens the next time this tab is visited.
    if (hostPrefill !== null) {
      ipc.send({ kind: "Lobby", command: { type: "clearHostPrefill" } });
    }
  }, [hostPrefill]);

  return { hostOpen, coopMissionToHost, hostPrefill, openHostDialog, closeHostDialog };
}
