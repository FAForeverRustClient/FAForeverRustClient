// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useForegroundInterval } from "./useForegroundInterval";
import { useFrameState } from "./useFrameState";
import { useAppStore } from "../../store/store";

const pristine = useAppStore.getState();
afterEach(() => { cleanup(); useAppStore.setState(pristine, true); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("suspends optional work while hidden and during games, refreshing once on return", () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const first = vi.fn();
  const second = vi.fn();
  function Probe({ tick }: { tick: () => void }) { useForegroundInterval(tick, 1000); return null; }
  const view = render(<Probe tick={first} />);
  expect(first).toHaveBeenCalledTimes(1);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(first).toHaveBeenCalledTimes(2);
  view.rerender(<Probe tick={second} />);
  act(() => { window.dispatchEvent(new Event("blur")); vi.advanceTimersByTime(1000); });
  expect(second).toHaveBeenCalledTimes(1);
  act(() => { visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); vi.advanceTimersByTime(5000); });
  expect(second).toHaveBeenCalledTimes(1);
  act(() => { visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); });
  expect(second).toHaveBeenCalledTimes(2);
  act(() => useAppStore.getState().hydrate({ ...pristine.state, lobby: { ...pristine.state.lobby, join: { type: "inGame" } } }));
  act(() => { vi.advanceTimersByTime(5000); });
  expect(second).toHaveBeenCalledTimes(2);
  act(() => useAppStore.getState().hydrate(pristine.state));
  expect(second).toHaveBeenCalledTimes(3);
});

it("does not repeat a poll when the window is hidden and shown again within one interval", () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const poll = vi.fn();
  function Probe() { useForegroundInterval(poll, 60_000); return null; }
  render(<Probe />);
  expect(poll).toHaveBeenCalledTimes(1);
  for (const state of ["hidden", "visible", "hidden", "visible"] as const) {
    act(() => { visibility.mockReturnValue(state); document.dispatchEvent(new Event("visibilitychange")); });
  }
  expect(poll).toHaveBeenCalledTimes(1);
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(poll).toHaveBeenCalledTimes(2);
});

it("coalesces frame updates and cancels queued hover work on clear", () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (work: () => void) => setTimeout(work, 16));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  let state: ReturnType<typeof useFrameState<number | null>>;
  function Probe() { state = useFrameState<number | null>(null); return <span>{state[0]}</span>; }
  const view = render(<Probe />);
  act(() => { state[1](10); state[1](20); vi.advanceTimersByTime(16); });
  expect(view.container.textContent).toBe("20");
  act(() => { state[1](30); state[2](null); vi.advanceTimersByTime(16); });
  expect(view.container.textContent).toBe("");
});
