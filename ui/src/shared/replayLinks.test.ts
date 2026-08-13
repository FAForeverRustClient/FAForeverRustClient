import { describe, expect, it } from "vitest";
import type { Game } from "../ipc/bindings";
import { liveReplayLink, onlineReplayLink } from "./replayLinks";

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 42,
    title: "Test",
    host: "Host",
    players: 2,
    maxPlayers: 4,
    map: "Seton's Clutch",
    modName: "faf",
    averageRating: 1500,
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    teams: {},
    simMods: {},
    ...overrides,
  };
}

describe("replay share links", () => {
  it("uses the public replay-vault URL for completed games", () => {
    expect(onlineReplayLink(123)).toBe("https://replay.faforever.com/123");
  });

  it("emits the Python live-link grammar accepted by chat", () => {
    const url = new URL(liveReplayLink(game(), "Player One"));
    expect(url.protocol).toBe("faflive:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/42/Player%20One.SCFAreplay");
    expect(url.searchParams.get("map")).toBe("Seton's Clutch");
    expect(url.searchParams.get("mod")).toBe("faf");
  });

  it("always emits a non-empty replay stream identity", () => {
    expect(new URL(liveReplayLink(game(), "  ")).pathname).toBe("/42/spectator.SCFAreplay");
  });
});
