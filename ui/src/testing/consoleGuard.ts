// Fail a mounted test that wrote to `console.error`.
//
// React reports what a mounted test most wants to catch there and nowhere
// else: an update outside `act`, a key missing from a list, a state change on
// a tree that was already torn down by a request answering late. None of
// those fail a test on their own, so a file that cares calls
// `failOnConsoleError()` once at its top and every test in it then fails on
// the first unexpected line, with the line in the message.
//
// The tree is unmounted before the check rather than after it, so an error
// raised while a component lets go of its effects is counted against the test
// that mounted it.

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi, type MockInstance } from "vitest";

/** Every `console.error` in each test of the calling file fails that test. */
export function failOnConsoleError(): void {
  let spy: MockInstance<typeof console.error> | null = null;

  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    // One turn of the event loop, so a promise or a zero-delay timer a
    // component left behind has its chance to complain. Skipped under fake
    // timers, where that turn would never come.
    if (!vi.isFakeTimers()) await new Promise((resolve) => setTimeout(resolve, 0));
    const lines = spy?.mock.calls.map((args) => args.map((arg) => String(arg)).join(" ")) ?? [];
    spy?.mockRestore();
    spy = null;
    expect(lines, "console.error during the test").toEqual([]);
  });
}
