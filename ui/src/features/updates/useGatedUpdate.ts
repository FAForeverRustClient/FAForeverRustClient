import { useAppStore } from "../../store/store";
import { updateRequiredRelease } from "../../store/reducers/clientUpdate";

/**
 * The release the update gate is standing for right now, or `null`. Shared by
 * the gate and the sidebar notice, which stands aside while the gate is up.
 *
 * `updateRequiredRelease` (the domain's twin) says whether an update is
 * overdue. Two carve-outs are added here, because the update slice cannot see
 * the lobby or the player's choice:
 *
 * - **A join or a matchmaker search in progress.** Taking the client away
 *   mid-match costs the player the chat, the lobby and the score screen of a
 *   game already running, which is worse than another twenty minutes on the
 *   old build. Every stage of a join counts, not only the running game: a gate
 *   over a map download or the preparation dialog covered the one way to
 *   cancel it, and a match-found prompt has a timer. The gate returns by itself
 *   when the game ends.
 * - **A version deferred for this session**, offered once a download has
 *   failed, so a network that can never fetch the installer does not lock the
 *   whole client. Not persisted: the gate is back at the next start.
 */
export function useGatedUpdate(deferredVersion: string | null) {
  const update = useAppStore((s) => s.state.clientUpdate);
  const join = useAppStore((s) => s.state.lobby.join);
  const matchmaking = useAppStore((s) => s.state.lobby.matchmaking);
  const release = updateRequiredRelease(update);
  return release && release.version !== deferredVersion && join.type === "idle"
    && (matchmaking.type === "idle" || matchmaking.type === "cancelled") ? release : null;
}
