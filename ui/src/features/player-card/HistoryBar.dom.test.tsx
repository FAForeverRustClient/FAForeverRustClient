// @vitest-environment happy-dom
//
// The bar the history tabs open on: the scope it states, and "Load full
// history" only while part of the history is on screen.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerMapStats } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { HistoryBar } from "./HistoryBar";

failOnConsoleError();

function stats(truncated: boolean): PlayerMapStats {
  return {
    totalGames: 1000,
    rankedGames: 900,
    wins: 500,
    losses: 400,
    undecided: 0,
    unranked: 100,
    unattributed: 0,
    maps: [],
    truncated,
    playerId: 7,
  };
}

describe("HistoryBar", () => {
  it("names the recent games and offers the rest", async () => {
    const user = userEvent.setup();
    const onLoadFull = vi.fn();
    render(<HistoryBar stats={stats(true)} full={false} onLoadFull={onLoadFull} />);

    expect(screen.getByText("Last 1,000 games")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Load full history" }));
    expect(onLoadFull).toHaveBeenCalledOnce();
  });

  it("is left out once the whole history is read", () => {
    const { container } = render(<HistoryBar stats={stats(false)} full={false} onLoadFull={() => {}} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("All games")).toBeNull();
  });

  it("keeps the scan's ceiling said once the whole history was asked for", () => {
    render(<HistoryBar stats={stats(true)} full onLoadFull={() => {}} />);

    expect(screen.queryByRole("button", { name: "Load full history" })).toBeNull();
    expect(screen.getByText(/more games than one scan covers/)).toBeTruthy();
  });

  it("puts the tab's own switch at its start", () => {
    render(
      <HistoryBar stats={stats(true)} full={false} onLoadFull={() => {}}>
        <button type="button">Performance</button>
      </HistoryBar>,
    );

    const start = screen.getByRole("button", { name: "Performance" }).parentElement;
    expect(start?.classList.contains("player-history-bar-start")).toBe(true);
  });

  it("keeps the tab's own switch, without the bar, once the whole history is read", () => {
    render(
      <HistoryBar stats={stats(false)} full={false} onLoadFull={() => {}}>
        <button type="button">Performance</button>
      </HistoryBar>,
    );

    const holder = screen.getByRole("button", { name: "Performance" }).parentElement;
    expect(holder?.classList.contains("player-history-switch")).toBe(true);
    expect(screen.queryByText("All games")).toBeNull();
  });
});
