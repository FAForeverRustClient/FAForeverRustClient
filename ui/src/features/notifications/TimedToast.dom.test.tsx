// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimedToast } from "./TimedToast";
import "../../testing/mounted";

afterEach(() => vi.useRealTimers());
it("pauses the remaining lifetime on hover and resumes after leaving", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const expire = vi.fn();
  const view = render(<TimedToast duration={5000} onExpire={expire}><button>Open</button></TimedToast>);
  act(() => { vi.advanceTimersByTime(2000); });
  fireEvent.pointerOver(view.container.querySelector("article")!);
  act(() => { vi.advanceTimersByTime(20000); });
  expect(expire).not.toHaveBeenCalled();
  fireEvent.pointerOut(view.container.querySelector("article")!);
  act(() => { vi.advanceTimersByTime(2999); });
  expect(expire).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(expire).toHaveBeenCalledOnce();
});
it("stays paused while focus moves between card controls and cleans up on unmount", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const expire = vi.fn();
  const view = render(<TimedToast duration={5000} onExpire={expire}><button>Open</button><button>Dismiss</button></TimedToast>);
  const [open, dismiss] = view.getAllByRole("button");
  act(() => open.focus());
  act(() => { vi.advanceTimersByTime(20000); });
  act(() => dismiss.focus());
  act(() => { vi.advanceTimersByTime(20000); });
  expect(expire).not.toHaveBeenCalled();
  view.unmount();
  act(() => { vi.advanceTimersByTime(20000); });
  expect(expire).not.toHaveBeenCalled();
});
