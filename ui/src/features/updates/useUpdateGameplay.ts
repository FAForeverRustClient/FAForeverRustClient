import { useAppStore } from "../../store/store";

/** Joins that ended in failure are over and do not count. */
const finishedJoins = new Set(["idle", "failed", "launchFailed"]);

/** Updates must leave the launch controls and running games accessible. */
export function useUpdateGameplay() {
  return useAppStore(({ state }) => !finishedJoins.has(state.lobby.join.type)
    || (state.lobby.matchmaking.type !== "idle" && state.lobby.matchmaking.type !== "cancelled")
    || state.training.lessonLaunch.type === "preparing" || state.training.lessonLaunch.type === "playing"
    || state.tutorials.launch.type === "preparing");
}
