// What the replay detail panel reads beyond the record it was opened with:
// the matching local file, the vault's own record of a local game, and the
// replay file's details and analysis, asked for on demand.

import { useEffect, useMemo, useRef } from "react";
import type { VaultReplay } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { normalizeReplayPath, replayReadKey } from "../../shared/rules/replayReadKey";
import { useAppStore } from "../../store/store";
import { mergeReplayTeamsWithLocal } from "./ReplayRoster";

interface Options {
  replay: VaultReplay;
  /** The file the panel was opened on, when the caller knows it. */
  initialLocalPath: string | undefined;
  /** Whether the panel was opened from the local library. */
  isLocal: boolean;
  /** Whether the panel is showing what the file says, which needs the details. */
  showingInsights?: boolean;
}

export function useReplayDetailResources({ replay, initialLocalPath, isLocal, showingInsights = false }: Options) {
  const localReplays = useAppStore((state) => state.state.replays.local);
  const replayDetails = useAppStore((state) => state.state.replays.replayDetails);
  const detailsLoading = useAppStore((state) => state.state.replays.detailsLoading);
  const heldDetailsError = useAppStore((state) => state.state.replays.detailsError);
  const heldAnalysis = useAppStore((state) => state.state.replays.analysis);
  const analysisLoading = useAppStore((state) => state.state.replays.analysisLoading);
  const heldAnalysisError = useAppStore((state) => state.state.replays.analysisError);
  const onlineLookups = useAppStore((state) => state.state.replays.onlineLookups);

  // By the same spelling-free path the reads are keyed by: a file opened by a
  // double-click or a file association arrives spelt differently from the
  // library's scan, and matched by exact text it found no library entry and
  // lost the local header's teams.
  const wantedPath = useMemo(
    () => (initialLocalPath ? normalizeReplayPath(initialLocalPath) : null),
    [initialLocalPath],
  );
  const localMatch = useMemo(
    () =>
      localReplays.find(
        (local) =>
          (replay.uid > 0 && local.uid === replay.uid)
          || (wantedPath !== null && normalizeReplayPath(local.path) === wantedPath),
      ),
    [localReplays, replay.uid, wantedPath],
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
  // What this panel's reads are called, and so where their answers land. The
  // game id where there is one; the file where there is not. Every file
  // without a game id is uid 0, and keyed by that, the second one opened found
  // the first one's analysis and never asked for its own.
  const readKey = replayReadKey(replay.uid, localPath);
  const details = replayDetails?.[readKey];
  const isLoadingDetails = detailsLoading === readKey;
  // Only this replay's failure. Two panels opened in turn can both have a
  // read in flight, and the other one's failure is not this replay's.
  const detailsError = heldDetailsError?.key === readKey ? heldDetailsError.reason : null;

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

  // The read whose details this panel has had on screen. The store keeps only
  // the newest `REPLAY_DETAILS_KEPT` answers, so this panel's own can be the
  // one that goes while it is still showing them; it then asks again rather
  // than going blank. Once: the answer is stored as the newest, which is the
  // last one the cap would take, and a failure is shown, not retried.
  const shownDetails = useRef<string | null>(null);
  useEffect(() => {
    if (!showingInsights) {
      shownDetails.current = null;
      return;
    }
    if (details) {
      shownDetails.current = readKey;
      return;
    }
    if (shownDetails.current !== readKey || isLoadingDetails) return;
    shownDetails.current = null;
    ipc.send({ kind: "Replays", command: { type: "loadDetails", payload: { uid: replay.uid, localPath } } });
  }, [showingInsights, details, readKey, isLoadingDetails, replay.uid, localPath]);

  // Only this replay's answer. The store holds one analysis at a time, so a
  // panel opened after another must not draw the last one's orders.
  const analysis = heldAnalysis?.key === readKey ? heldAnalysis : null;
  const analysisError = heldAnalysisError?.key === readKey ? heldAnalysisError.reason : null;
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

  // Closing the panel calls its reads off. Either can be the whole replay
  // fetched from the vault and then walked command by command, and the
  // answer would land in a panel nobody has open; the backend drops the work
  // and clears the loading lines, so the next panel on this replay asks
  // again. Only a read still running for this panel is called off: the ref
  // holds what was true at the last render, which is what the cleanup sees.
  const runningRead = useRef<{ uid: number; localPath: string | undefined } | null>(null);
  const readRunning = isLoadingDetails || analysisLoading === readKey;
  useEffect(() => {
    runningRead.current = readRunning ? { uid: replay.uid, localPath } : null;
  }, [readRunning, replay.uid, localPath]);
  useEffect(() => () => {
    const running = runningRead.current;
    if (running) {
      ipc.send({ kind: "Replays", command: { type: "cancelReads", payload: running } });
    }
  }, []);

  /** Ask for whatever the insights panel needs and is not already coming. */
  const requestInsights = () => {
    // Both reads, in the order they are wanted. The file is fetched
    // once and the second walk reads it off disk, so the expensive
    // half costs the reader nothing until they reach a tab that
    // needs it.
    if (!details && !isLoadingDetails) loadDetails();
    if (!analysis && analysisLoading !== readKey) loadAnalysis();
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
    analysisLoading: analysisLoading === readKey,
    analysisError,
    requestInsights,
  };
}
