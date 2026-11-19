import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, ClientNotification, Game } from "../../ipc/bindings";
import { INITIAL_STATE } from "../../ipc/initialState";
import { notificationArtwork } from "./notificationArtwork";

const shell = vi.hoisted(() => ({ inside: false }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => shell.inside,
  convertFileSrc: (path: string, scheme = "asset") => `http://${scheme}.localhost/${encodeURIComponent(path)}`,
}));

function stateWithGameOn(map: string): AppState {
  const game = { id: 7, map } as Game;
  return { ...INITIAL_STATE, lobby: { ...INITIAL_STATE.lobby, games: [game] } };
}

const OPEN_GAME = { action: { type: "openGame", payload: { gameId: 7 } } } as ClientNotification;

describe("notificationArtwork", () => {
  beforeEach(() => {
    shell.inside = true;
  });
  afterEach(() => {
    shell.inside = false;
  });

  it("passes on the preview service's art for a base-game map, not the shell's own picture", () => {
    // A tile leads with the original game's picture of a base-game map; the
    // notification keeps the https art it has always shown.
    expect(notificationArtwork(OPEN_GAME, stateWithGameOn("scmp_009"))).toBe(
      "https://content.faforever.com/maps/previews/small/scmp_009.png",
    );
  });

  it("still shows a vault map's art", () => {
    expect(notificationArtwork(OPEN_GAME, stateWithGameOn("setons_clutch.v0002"))).toBe(
      "https://content.faforever.com/maps/previews/small/setons_clutch.v0002.png",
    );
  });
});
