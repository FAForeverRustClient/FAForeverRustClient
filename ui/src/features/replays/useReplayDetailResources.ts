// What the replay detail panel reads beyond the record it was opened with:
// the matching local file, the vault's own record of a local game, and the
// replay file's details and analysis, asked for on demand.

import { useEffect, useMemo } from "react";
import type { VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { mergeReplayTeamsWithLocal } from "./ReplayRoster";

interface Options {
  replay: VaultReplay;
  /** The file the panel was opened on, when the caller knows it. */
  initialLocalPath: string | undefined;
  /** Whether the panel was opened from the local library. */
  isLocal: boolean;
}

export function useReplayDetailResources({ replay, initialLocalPath, isLocal }: Options) {
  const localReplays = useAppStore((state) => state.state.replays.local);
  const replayDetails = useAppStore((state) => state.state.replays.replayDetails);
  const detailsLoading = useAppStore((state) => state.state.replays.detailsLoading);
  const detailsError = useAppStore((state) => state.state.replays.detailsError);
  const heldAnalysis = useAppStore((state) => state.state.replays.analysis);
  const analysisLoading = useAppStore((state) => state.state.replays.analysisLoading);
  const analysisError = useAppStore((state) => state.state.replays.analysisError);
  const onlineLookups = useAppStore((state) => state.state.replays.onlineLookups);

  const localMatch = localReplays.find(
    (local) => (replay.uid > 0 && local.uid === replay.uid) || (initialLocalPath && local.path === initialLocalPath),
  );
  // The vault's own record of this game, asked for only when the panel was
  // opened from the local library: it is the sole place a local replay's
  // rating change can come from. `undefined` until the answer lands.
  const onlineLookup = replay.uid > 0 ? onlineLookups?.[replay.uid] : undefined;
  useEffect(() => {
    if (!isLocal || replay.uid <= 0 || onlineLookup) return;
    ipc.send({ kind: "Replays", command: { type: "lookUpOnline", payload: { uid: replay.uid } } });
  }, [isLocal, replay.uid, onlineLookup]);
  // A found lookup is the richer source: it carries outcomes and rating
  // changes the file never had. The local header still fills in what the
  // vault leaves out (faction and rating for a player it did not list).
  // Memoised, because the lineup that draws them is: a new array on every
  // redraw (the generator's progress, an answer for another replay) would
  // redraw the whole roster with it.
  const onlineTeams = onlineLookup?.type === "found" ? onlineLookup.payload.teams : null;
  const localTeams = localMatch?.teams;
  const detailTeams = useMemo(
    () => mergeReplayTeamsWithLocal(onlineTeams && onlineTeams.length > 0 ? onlineTeams : replay.teams, localTeams),
    [onlineTeams, replay.teams, localTeams],
  );
  const localPath = initialLocalPath || localMatch?.path;
  const details = replay.uid ? replayDetails?.[replay.uid] : undefined;
  const isLoadingDetails = detailsLoading === replay.uid;

  const loadDetails = () => {
    ipc.send({
      kind: "Replays",
      command: {
        type: "loadDetails",
        payload: {
          uid: replay.uid,
          localPath,
        },
      },
    });
  };

  // Only this replay's answer. The store holds one analysis at a time, so a
  // panel opened after another must not draw the last one's orders.
  const analysis = heldAnalysis?.uid === replay.uid ? heldAnalysis : null;
  const loadAnalysis = () => {
    ipc.send({
      kind: "Replays",
      command: {
        type: "loadAnalysis",
        payload: {
          uid: replay.uid,
          localPath,
        },
      },
    });
  };

  /** Ask for whatever the insights panel needs and is not already coming. */
  const requestInsights = () => {
    // Both reads, in the order they are wanted. The file is fetched
    // once and the second walk reads it off disk, so the expensive
    // half costs the reader nothing until they reach a tab that
    // needs it.
    if (!details && !isLoadingDetails) loadDetails();
    if (!analysis && analysisLoading !== replay.uid) loadAnalysis();
  };

  return {
    localMatch,
    onlineLookup,
    detailTeams,
    localPath,
    details,
    isLoadingDetails,
    detailsError,
    analysis,
    analysisLoading: analysisLoading === replay.uid,
    analysisError,
    requestInsights,
  };
}
