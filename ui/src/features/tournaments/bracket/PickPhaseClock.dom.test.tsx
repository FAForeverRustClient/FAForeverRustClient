// @vitest-environment happy-dom
//
// The pick clock counts down from the last reading of the event. A new reading
// arrives between two ticks of the panel's clock, so for up to a second that
// clock is older than the reading; the time left must not grow because of it.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickPhase } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { tourney } from "../fixtures";
import { PickPhasePanel } from "./PickPhasePanel";

vi.mock("../../../ipc/client");

failOnConsoleError();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function picks(secondsLeft: number): PickPhase {
  return {
    open: true,
    half: 1,
    field: ["a", "b"],
    order: ["a"],
    picks: [],
    available: ["b"],
    turn: "a",
    myTurn: true,
    secondsLeft,
    secondsPerPick: 60,
    log: [],
    stageTwo: false,
    unbeaten: false,
    restSeeded: false,
    pool: [],
    poolBottom: false,
    records: [],
    drawn: [],
  };
}

describe("the pick clock", () => {
  it("shows a new reading as it is, not a second more", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const props = { event: tourney(), busy: false, onAdmin: vi.fn(), onRefresh: vi.fn() };
    const view = render(<PickPhasePanel {...props} picks={picks(30)} />);
    expect(screen.getByText(/0:30/)).toBeTruthy();

    // The next poll lands 1.5 s later, before the panel's own tick.
    vi.setSystemTime(1_800_000_001_500);
    view.rerender(<PickPhasePanel {...props} picks={picks(29)} />);
    expect(screen.getByText(/0:29/)).toBeTruthy();
    expect(screen.queryByText(/0:31/)).toBeNull();
  });
});
