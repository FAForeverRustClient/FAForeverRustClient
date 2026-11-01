// @vitest-environment happy-dom
//
// Fourteen views offer the player menu. With the menu closed, none of them may
// redraw because the lobby or the social directory changed, which they all did
// while the hook itself subscribed to everything the menu shows. Open, the menu
// still follows live data.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Game } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { seedStore } from "../../testing/mounted";
import { usePlayerMenu } from "./usePlayerMenu";

vi.mock("../../ipc/client");

failOnConsoleError();

afterEach(cleanup);

function lobbyUpdate(games: Game[]) {
  act(() => useAppStore.setState((current) => ({
    state: { ...current.state, lobby: { ...current.state.lobby, games, liveGames: [] } },
  })));
}

function socialUpdate() {
  act(() => useAppStore.setState((current) => ({
    state: { ...current.state, social: { ...current.state.social, friends: [...current.state.social.friends] } },
  })));
}

const hostedBy = (host: string): Game => ({
  id: 7,
  title: "Open lobby",
  host,
  players: 1,
  maxPlayers: 8,
  map: "scmp_009",
  modName: "faf",
  averageRating: 1_200,
  ratingType: "global",
  passwordProtected: false,
  visibility: "public",
  gameType: "custom",
  launchedAt: null,
  hostedAt: null,
  ratingMin: null,
  ratingMax: null,
  enforceRatingRange: false,
  teams: { "1": [host] },
  simMods: {},
});

describe("the player menu", () => {
  it("leaves its view alone while closed and follows live data while open", () => {
    let renders = 0;
    function Probe() {
      renders += 1;
      const { openPlayerMenu, playerMenu } = usePlayerMenu();
      return (
        <>
          <button type="button" onContextMenu={(event) => openPlayerMenu("Host1", event)}>Host1</button>
          {playerMenu}
        </>
      );
    }
    seedStore((state) => ({
      ...state,
      social: { ...state.social, players: [{
        id: 41, login: "Host1", globalRating: 1500, ratings: [], country: "", clan: "", avatarUrl: "", avatarTooltip: "",
      }] },
    }));
    render(<Probe />);

    const closed = renders;
    lobbyUpdate([]);
    socialUpdate();
    expect(renders).toBe(closed);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Host1" }));
    expect(screen.queryByText("Join game")).toBeNull();
    // The open menu still reads the lobby: the game Host1 hosts appears in it.
    lobbyUpdate([hostedBy("Host1")]);
    expect(screen.getByText("Join game")).toBeTruthy();
  });
});
