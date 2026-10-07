// @vitest-environment happy-dom
//
// Recent results under the queues: with nothing to list it is one slim line
// (heading, state, profile link), and the full card with its table only once
// there are games.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReplayPlayer, VaultReplay, VaultStatus } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { seedStore } from "../../../testing/mounted";
import { MatchmakerRecentGames } from "./MatchmakerRecentGames";

vi.mock("../../../ipc/client");

failOnConsoleError();

const player = (name: string, outcome: string): ReplayPlayer => ({
  name,
  avatarUrl: null,
  faction: 1,
  rating: 1000,
  ratingChange: 12,
  outcome,
  score: null,
});

const game = {
  uid: 4242,
  map: "scmp_009",
  mapThumbnailUrl: "",
  startTime: "2026-10-05T22:00:00Z",
  replayAvailable: true,
  teams: [
    { team: 2, players: [player("Nory", "VICTORY")] },
    { team: 3, players: [player("Bob", "DEFEAT")] },
  ],
} as unknown as VaultReplay;

function mount(games: VaultReplay[], status: VaultStatus) {
  seedStore((state) => ({
    ...state,
    replays: { ...state.replays, recentMatchmaker: games, recentMatchmakerStatus: status },
  }));
  const { container } = render(<MatchmakerRecentGames playerName="Nory" vault={[]} />);
  return container.querySelector(".matchmaker-recent");
}

describe("MatchmakerRecentGames", () => {
  it("is one slim line while there are no games", () => {
    const section = mount([], { type: "ready" });

    expect(section?.classList.contains("is-compact")).toBe(true);
    expect(screen.getByRole("heading", { name: "Recent results" })).toBeTruthy();
    expect(screen.getByText("No matchmaker games yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View results on profile" })).toBeTruthy();
    expect(screen.queryByText("Your games")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says why on the same line when the load failed", () => {
    mount([], { type: "failed", payload: { reason: "timed out" } });

    expect(screen.getByRole("alert").textContent).toBe("Could not load your recent games: timed out");
  });

  it("is the full card with its table once there are games", () => {
    const section = mount([game], { type: "ready" });

    expect(section?.classList.contains("is-compact")).toBe(false);
    expect(screen.getByText("Your games")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
  });
});
