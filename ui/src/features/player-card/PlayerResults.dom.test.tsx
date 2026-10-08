// @vitest-environment happy-dom
//
// The results list: its record line (wins, losses and draws among the rows on
// screen, and the win rate by the Maps tab's rule, draws left out, following
// "Show more" as it adds rows), and the small map picture on every row.

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
    mapFolder: "canis_river.v0003",
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

function mount(games: PlayerGameResult[] = history()) {
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

describe("PlayerResults map pictures", () => {
  it("draws each game's map from its folder, and a generated map's picture for a generated one", () => {
    const generated: PlayerGameResult = { ...game(2, "loss"), map: "", mapFolder: "", generated: true };
    mount([game(1, "win"), generated]);

    const [played, mapgen] = screen.getAllByRole("row").slice(1);
    const playedPicture = played.querySelector("img.player-results-map-thumb");
    expect(playedPicture?.getAttribute("src")).toBe(
      "https://content.faforever.com/maps/previews/small/canis_river.v0003.png",
    );
    expect(played.textContent).toContain("Seton's Clutch");

    const mapgenPicture = mapgen.querySelector("img.player-results-map-thumb");
    expect(mapgenPicture?.getAttribute("src")).toBe("/assets/mapgen-placeholder.png");
    expect(mapgen.textContent).toContain("Mapgen / generated map");
  });

  it("leads each row with the map, picture first, so the map column takes the spare width", () => {
    mount([game(1, "win")]);

    const [header, row] = screen.getAllByRole("row");
    expect([...header.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
      "Map", "Date", "Queue", "Result", "Rating", "Replay",
    ]);
    const first = row.querySelector("td");
    expect(first?.classList.contains("player-results-map")).toBe(true);
    expect(first?.firstElementChild?.firstElementChild?.classList.contains("player-results-map-thumb")).toBe(true);
  });
});
