import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "./bindings";

const reportEventCost = vi.fn();
vi.mock("./client", () => ({ ipc: { reportEventCost } }));

const { eventName, measureEventApply } = await import("./eventCost");

const connecting: AppEvent = { kind: "Session", event: { type: "connecting" } };

/** Apply `event` as if the store took `milliseconds` to take it in. */
function applyTaking(event: AppEvent, milliseconds: number): void {
  let now = 1_000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  measureEventApply(event, () => {
    now += milliseconds;
  });
  clock.mockRestore();
}

describe("eventCost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reportEventCost.mockClear();
  });

  afterEach(() => {
    // Close the window this test opened, so the next starts from nothing.
    vi.advanceTimersByTime(30_000);
    vi.useRealTimers();
  });

  it("names an event by slice and type, never by payload", () => {
    expect(eventName(connecting)).toBe("Session:connecting");
  });

  it("writes nothing for a window of cheap events", () => {
    for (let i = 0; i < 100; i += 1) applyTaking(connecting, 1);
    vi.advanceTimersByTime(30_000);
    expect(reportEventCost).not.toHaveBeenCalled();
  });

  it("reports a window with one slow event, naming it", () => {
    applyTaking(connecting, 2);
    applyTaking(connecting, 80);
    vi.advanceTimersByTime(30_000);
    expect(reportEventCost).toHaveBeenCalledWith(2, 82, "Session:connecting", 80);
  });
});
