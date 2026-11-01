import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/store";

/**
 * Optional presentation work sleeps while the window is hidden or a game runs.
 *
 * A visible window keeps ticking even unfocused: a client on a second screen
 * still shows its countdowns. Enabling runs the callback at once; returning
 * from a hidden window or a game does so only if a full interval has passed,
 * so toggling visibility cannot burst a poll.
 *
 * `duringGames` keeps the work running while a game or replay runs, for the
 * rare display that is read precisely then: a matchmaker search counting down
 * while its player watches a replay.
 */
export function useForegroundInterval(callback: () => void, delay: number, enabled = true, duringGames = false) {
  const gameActive = useAppStore((store) =>
    !duringGames
    && (store.state.lobby.join.type === "inGame" || store.state.lobby.join.type === "launched" || store.state.replays.status.type === "playing"));
  const latest = useRef(callback);
  useEffect(() => { latest.current = callback; });
  const lastRun = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    // Turning the work on, as opposed to coming back to it, refreshes at once.
    if (!enabled) lastRun.current = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      lastRun.current = Date.now();
      latest.current();
      timer = setTimeout(run, delay);
    };
    const stop = () => { clearTimeout(timer); timer = undefined; };
    const update = () => {
      const wanted = enabled && !gameActive && document.visibilityState !== "hidden";
      if (wanted === (timer !== undefined)) return;
      stop();
      if (!wanted) return;
      const remaining = lastRun.current + delay - Date.now();
      if (remaining <= 0) run();
      else timer = setTimeout(run, remaining);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", update);
    };
  }, [delay, enabled, gameActive]);
}
