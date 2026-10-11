// @vitest-environment happy-dom
//
// One game as a tile: facts without a caption over each, the map and the host
// under the title, the tags on the third line with the rating range first, and
// the slots and rating at the bottom.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Game } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { GameTile } from "./GameTile";

vi.mock("../../../ipc/client");

failOnConsoleError();

function game(changes: Partial<Game> = {}): Game {
  return {
    id: 1,
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
    ...changes,
  };
}

function mountTile(changes: Partial<Game> = {}) {
  const { container } = render(
    <GameTile
      game={game(changes)}
      vault={[]}
      vaultMods={[]}
      friendSet={new Set()}
      selected={false}
      now={Date.now()}
      onSelect={() => {}}
      onJoin={() => {}}
    />,
  );
  const part = (selector: string) => container.querySelector<HTMLElement>(selector);
  return { container, part };
}

describe("GameTile", () => {
  it("shows its facts without a caption over each, with the map and the host under the title", () => {
    const { container, part } = mountTile();

    // The picture carries no plate: the map's name is in the line under the title.
    expect(part(".game-tile-map")?.textContent).toBe("");
    expect(part(".game-tile-where-map")?.textContent).toBeTruthy();
    expect(part(".game-tile-where-host")?.textContent).toBe("Sui");
    expect(part(".game-tile-stats")?.textContent).toContain("1/4");
    expect(part(".game-tile-stats")?.textContent).toContain("Ø 1829");
    for (const caption of ["Host:", "Version", "Ø Rating", "player"]) {
      expect(container.textContent).not.toContain(caption);
    }
  });

  it("draws a dot per slot, filled for each player, and smaller ones for a big lobby", () => {
    const { part, container } = mountTile();
    expect(container.querySelectorAll(".game-tile-slots i")).toHaveLength(4);
    expect(container.querySelectorAll(".game-tile-slots i.is-taken")).toHaveLength(1);
    expect(part(".game-tile-slots")?.classList.contains("is-dense")).toBe(false);

    const big = mountTile({ id: 2, maxPlayers: 16 });
    expect(big.container.querySelectorAll(".game-tile-slots i")).toHaveLength(16);
    expect(big.part(".game-tile-slots")?.classList.contains("is-dense")).toBe(true);
  });

  it("tags the featured mod only when it is not the tab's own", () => {
    expect(mountTile().part(".game-tile-flags")?.childElementCount).toBe(0);
    expect(mountTile({ id: 3, modName: "coop" }).part(".game-tile-flags")?.childElementCount).toBe(0);
    expect(mountTile({ id: 4, modName: "fafbeta" }).part(".game-tile-flags")?.textContent).toBe("FAF Beta Balance");
  });

  it("puts the rating range first among the tags, where the line's clipping cannot take it", () => {
    const { part } = mountTile({ ratingMin: 1600, ratingMax: 3200, enforceRatingRange: true, modName: "fafbeta" });
    expect(part(".game-tile-stats .game-rating-range")).toBeNull();
    const range = part(".game-tile-flags > :first-child");
    expect(range?.classList.contains("game-rating-range")).toBe(true);
    expect(range?.textContent).toBe("1600-3200");
    expect(range?.classList.contains("is-enforced")).toBe(true);
  });
});
