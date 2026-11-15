import { useRef } from "react";
import { ipc } from "../../ipc/client";
import { useForegroundInterval } from "../../shared/hooks/useForegroundInterval";
import { settle } from "./tourneyCommands";

const POLL_MS = 5_000;

/** The service has no push stream: keep the visible captains' draft current. */
export function useTourneyDraftRefresh(tournamentId: string | null) {
  const inFlight = useRef(new Set<string>());
  useForegroundInterval(() => {
    if (tournamentId === null || inFlight.current.has(tournamentId)) return;
    const requests = inFlight.current;
    requests.add(tournamentId);
    ipc.run(settle({ type: "refreshDetail", payload: { tournamentId } })
      .finally(() => requests.delete(tournamentId)));
  }, POLL_MS, tournamentId !== null, true);
}
