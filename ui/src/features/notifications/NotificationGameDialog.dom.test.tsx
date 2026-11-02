// @vitest-environment happy-dom
//
// "View game" on a notification opens the Play tab's game preview, and it has
// to arrive as that same dialog: in the modal panel over the client, not drawn
// in place inside the notification centre at the foot of the sidebar.

import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Game } from "../../ipc/bindings";
import { seedStore } from "../../testing/mounted";
import NotificationGameDialog from "./NotificationGameDialog";

vi.mock("../../ipc/client");

const game: Game = {
  id: 7,
  title: "want a game?",
  host: "Sui",
  players: 1,
  maxPlayers: 4,
  map: "zz_open_field.v0001",
  modName: "faf",
  averageRating: 1829,
  ratingType: "global",
  passwordProtected: false,
  visibility: "public",
  gameType: "custom",
  launchedAt: null,
  hostedAt: null,
  ratingMin: null,
  ratingMax: null,
  enforceRatingRange: false,
  teams: { "1": ["Sui"], "2": [] },
  simMods: {},
};

it("opens the game preview inside the modal panel the Play tab uses", () => {
  seedStore((state) => ({ ...state, lobby: { ...state.lobby, games: [game] } }));
  render(<NotificationGameDialog id={7} onClose={() => {}} />);
  const panel = document.querySelector(".modal-panel.game-preview-modal");
  expect(panel?.getAttribute("role")).toBe("dialog");
  expect(panel?.querySelector(".game-preview-dialog")).not.toBeNull();
});
