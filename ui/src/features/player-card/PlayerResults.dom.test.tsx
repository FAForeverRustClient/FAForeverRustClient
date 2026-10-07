// @vitest-environment happy-dom
//
// The results list's record line: wins, losses and draws among the rows on
// screen, and the win rate by the Maps tab's rule (draws left out), following
// "Show more" as it adds rows.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerGameResult, PlayerMapStats } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { seedStore } from "../../testing/mounted";
import { PlayerResults } from "./PlayerResults";

vi.mock("../../ipc/client");

failOnConsoleError();

const PLAYER = 7;

function game(gameId: number, outcome: "win" | "loss" | "draw"): PlayerGameResult {
  return {
    gameId,
    playedAt: "2026-10-05T22:00:00Z",
    queue: "global",
    map: "Seton's Clutch",
    generated: false,
    outcome,
    ratingChangeHundredths: null,
  };
}

/** The first page of 50: 30 won, 18 lost, 2 drawn. Then 10 more, all won. */
function history(): PlayerGameResult[] {
  const outcomes = [
    ...Array<"win">(30).fill("win"),
    ...Array<"loss">(18).fill("loss"),
    ...Array<"draw">(2).fill("draw"),
    ...Array<"win">(10).fill("win"),
  ];
  return outcomes.map((outcome, index) => game(1000 + index, outcome));
}

function mount() {
  const games = history();
  const stats: PlayerMapStats = {
    totalGames: games.length + 3,
    rankedGames: games.length,
    wins: 40,
    losses: 18,
    undecided: 3,
    unranked: 0,
    unattributed: 0,
    maps: [],
    truncated: false,
    playerId: PLAYER,
    games,
  };
  seedStore((state) => ({
    ...state,
    playerCard: { ...state.playerCard, mapStats: stats, mapStatsStatus: "ready" },
  }));
  render(<PlayerResults playerId={PLAYER} />);
}

const summary = () => screen.getByText(/games shown/).closest("p")?.textContent ?? "";

describe("PlayerResults record line", () => {
  it("sums up the rows on screen and follows Show more", async () => {
    const user = userEvent.setup();
    mount();

    expect(summary()).toBe("Of the 50 games shown: Won 30 · Lost 18 · Drawn 2 · Win rate 62.5%");

    await user.click(screen.getByRole("button", { name: "Show more (50/60)" }));

    expect(summary()).toBe("Of the 60 games shown: Won 40 · Lost 18 · Drawn 2 · Win rate 69.0%");
  });
});
