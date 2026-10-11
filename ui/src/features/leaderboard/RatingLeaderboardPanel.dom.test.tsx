// @vitest-environment happy-dom
//
// The rating leaderboard against its own re-runs. Paging and Refresh both run
// the executed query again; a player name typed but not searched for must
// survive the answer, and the selected player's details must show the
// numbers of the page on screen, not of the page they were clicked on.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, LeaderboardEntry, RatingPage, RatingQuery } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { RatingLeaderboardPanel } from "./RatingLeaderboardPanel";

vi.mock("../../ipc/client");

failOnConsoleError();

function entry(playerId: number, playerName: string, rank: number, rating: number, gamesPlayed: number): LeaderboardEntry {
  return {
    playerId,
    rank,
    playerName,
    avatarUrl: null,
    avatarTooltip: null,
    score: null,
    rating,
    mean: null,
    deviation: null,
    gamesPlayed,
    wonGames: null,
    updateTime: null,
    division: null,
    subdivision: null,
    divisionOrder: null,
    highestScore: null,
    divisionImageUrl: null,
    divisionMediumImageUrl: null,
    returningPlayer: null,
  };
}

function page(entries: LeaderboardEntry[], number = 1): RatingPage {
  return { entries, page: number, pageSize: 50, totalPages: 3, totalResults: 150 };
}

function mount(executed: RatingQuery, entries: LeaderboardEntry[]) {
  seedStore((state) => ({
    ...state,
    leaderboard: {
      ...state.leaderboard,
      catalogStatus: { type: "ready" },
      ratingLeaderboards: [{ id: 1, technicalName: "global", description: "" }],
      ratingQuery: executed,
      ratingPage: page(entries),
      ratingsStatus: { type: "ready" },
    },
  }));
  render(<RatingLeaderboardPanel />);
  clearSentCommands();
}

/** The backend's answer to a ratings load: the query it ran and its page. */
function answer(query: RatingQuery, entries: LeaderboardEntry[]) {
  applyEvent({
    kind: "Leaderboard",
    event: { type: "ratingsLoaded", payload: { query, page: page(entries, query.page) } },
  });
}

const loads = () =>
  sentCommands().flatMap((command: AppCommand) =>
    command.kind === "Leaderboard" && command.command.type === "loadRatings"
      ? [command.command.payload.query]
      : [],
  );

const playerField = () => screen.getByPlaceholderText<HTMLInputElement>("Player name");

describe("Rating leaderboard re-runs", () => {
  it("keeps a typed but unsearched player name through Refresh and paging", async () => {
    const user = userEvent.setup();
    const executed: RatingQuery = {
      leaderboard: "global",
      page: 1,
      pageSize: 50,
      activeOnly: true,
      updatedAfter: null,
      updatedBefore: null,
      player: "",
      includeFormerNames: false,
    };
    mount(executed, [entry(1, "Alpha", 1, 2400, 900)]);
    await user.type(playerField(), "draft");

    await user.click(screen.getByRole("button", { name: "Refresh rankings" }));
    // Refresh runs the search on screen, not the draft.
    expect(loads()).toEqual([executed]);
    answer(executed, [entry(1, "Alpha", 1, 2400, 900)]);
    expect(playerField().value).toBe("draft");

    answer({ ...executed, page: 2 }, [entry(2, "Bravo", 51, 1900, 300)]);
    expect(playerField().value).toBe("draft");

    // A search whose player changed is taken over as before.
    answer({ ...executed, player: "Charlie" }, [entry(3, "Charlie", 7, 2100, 500)]);
    expect(playerField().value).toBe("Charlie");
  });

  it("shows the selected player's numbers from the refreshed page", async () => {
    const user = userEvent.setup();
    const executed: RatingQuery = {
      leaderboard: "global",
      page: 1,
      pageSize: 50,
      activeOnly: true,
      updatedAfter: null,
      updatedBefore: null,
      player: "",
      includeFormerNames: false,
    };
    mount(executed, [entry(1, "Alpha", 1, 2400, 900), entry(2, "Bravo", 2, 2300, 800)]);
    await user.click(screen.getByText("Bravo"));
    const details = () => screen.getByRole("complementary");
    expect(within(details()).getByText("#2")).toBeTruthy();

    answer(executed, [entry(2, "Bravo", 1, 2450, 812), entry(1, "Alpha", 2, 2390, 901)]);

    expect(within(details()).getByText("#1")).toBeTruthy();
    expect(within(details()).getByText("2450")).toBeTruthy();
    expect(within(details()).getByText("812")).toBeTruthy();
  });
});
