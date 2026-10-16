import { useAppStore } from "../../store/store";

/** Updates must leave the launch controls and running games accessible. */
export function useUpdateGameplay() {
  return useAppStore(({ state }) => state.lobby.join.type !== "idle"
    || (state.lobby.matchmaking.type !== "idle" && state.lobby.matchmaking.type !== "cancelled")
    || state.training.lessonLaunch.type === "preparing" || state.training.lessonLaunch.type === "playing"
    || state.tutorials.launch.type === "preparing");
}
