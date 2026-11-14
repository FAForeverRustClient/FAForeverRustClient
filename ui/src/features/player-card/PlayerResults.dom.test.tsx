// @vitest-environment happy-dom
//
// The results list: its three tiles (games, the win rate by the Maps tab's
// rule, draws left out, and the rating change over every filtered game, not
// only the rows "Show more" has reached), the history bar only while part of
// the history is unread, and the small map picture on every row.

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

function game(gameId: number, outcome: "win" | "loss" | "draw", ratingChangeHundredths: number | null = null): PlayerGameResult {
  return {
    gameId,
    playedAt: "2026-10-05T22:00:00Z",
    queue: "global",
    map: "Seton's Clutch",
    mapFolder: "canis_river.v0003",
    generated: false,
    outcome,
    ratingChangeHundredths,
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

function mount(games: PlayerGameResult[] = history(), truncated = false) {
  const stats: PlayerMapStats = {
    totalGames: games.length + 3,
    rankedGames: games.length,
    wins: 40,
    losses: 18,
    undecided: 3,
    unranked: 0,
    unattributed: 0,
    queues: [],
    maps: [],
    truncated,
    playerId: PLAYER,
    games,
  };
  seedStore((state) => ({
    ...state,
    playerCard: { ...state.playerCard, mapStats: stats, mapStatsStatus: "ready" },
  }));
  render(<PlayerResults playerId={PLAYER} />);
}

/** A tile's label and everything under it, as one string. */
const tile = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement?.textContent ?? "";

describe("PlayerResults tiles", () => {
  it("sum up every filtered game, not only the rows on screen", async () => {
    const user = userEvent.setup();
    mount();

    expect(tile("Games")).toBe("Games60Ranked 0 · Unranked 60");
    expect(tile("Win rate")).toBe("Win rate69.0%Won 40 · Lost 18 · Drawn 2");
    expect(tile("Rating")).toBe("Rating–No rating data");

    await user.click(screen.getByRole("button", { name: "Show more (50/60)" }));

    expect(tile("Win rate")).toBe("Win rate69.0%Won 40 · Lost 18 · Drawn 2");
  });

  it("add the rating change and its average over the rated games", () => {
    // +15 and -5 rated, the third without rating data: +10 in all, +5 a game.
    mount([game(1, "win", 1500), game(2, "loss", -500), game(3, "win", null)]);

    expect(tile("Games")).toBe("Games3Ranked 2 · Unranked 1");
    expect(tile("Rating")).toBe("Rating+10.0+5.0 per game");
  });
});

describe("PlayerResults history bar", () => {
  it("is left out once the whole history is read", () => {
    mount();
    expect(screen.queryByText("All games")).toBeNull();
  });

  it("is there while part of the history is unread", () => {
    mount(history(), true);
    expect(screen.getByRole("button", { name: "Load full history" })).toBeTruthy();
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
