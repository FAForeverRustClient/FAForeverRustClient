// @vitest-environment happy-dom
//
// The shell mounts the player card for good, and closing it keeps the last
// profile. A closed card must not keep the subscriptions its content needs: it
// used to search both game lists and the player directory again on every
// lobby and social update with nothing on screen.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Game, PlayerCardProfile } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { seedStore } from "../../testing/mounted";
import { PlayerCardModal } from "./PlayerCardModal";

vi.mock("../../ipc/client");

failOnConsoleError();

afterEach(cleanup);

/** A game list whose `find` calls are counted. */
function countedGames(counter: { scans: number }): Game[] {
  const games: Game[] = [];
  const find = games.find.bind(games);
  games.find = ((...args: Parameters<typeof find>) => {
    counter.scans += 1;
    return find(...args);
  }) as typeof games.find;
  return games;
}

describe("a closed player card", () => {
  it("does not look through the game lists while closed, even with a profile kept", () => {
    const profile: PlayerCardProfile = {
      playerId: 9101, login: "Kept", country: "", registeredAt: "2020-01-01T00:00:00Z",
      userAgent: "", avatars: [], names: [], clan: null, ratings: [], leaguePlacements: [], events: [],
      achievements: [], warnings: [], matchedFormerName: null,
    };
    const counter = { scans: 0 };
    seedStore((state) => ({
      ...state,
      playerCard: { ...state.playerCard, open: false, profile },
      lobby: { ...state.lobby, games: countedGames(counter), liveGames: countedGames(counter) },
    }));
    const view = render(<PlayerCardModal />);
    act(() => useAppStore.setState((current) => ({
      state: {
        ...current.state,
        lobby: { ...current.state.lobby, games: countedGames(counter), liveGames: countedGames(counter) },
        social: { ...current.state.social, friends: [...current.state.social.friends] },
      },
    })));
    expect(view.container.childElementCount).toBe(0);
    expect(counter.scans).toBe(0);
  });
});
