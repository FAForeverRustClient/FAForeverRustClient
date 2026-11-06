// @vitest-environment happy-dom
//
// One game as a tile: facts without a caption over each, the map's name on its
// picture, the host on the line under the title, the tags after it with the
// rating range first, and the slots and rating at the bottom.

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

function mountTile(changes: Partial<Game> = {}, friendSet: ReadonlySet<string> = new Set()) {
  const { container } = render(
    <GameTile
      game={game(changes)}
      vault={[]}
      vaultMods={[]}
      friendSet={friendSet}
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
  it("shows its facts without a caption over each, with the map on its picture and the host under the title", () => {
    const { container, part } = mountTile();

    // The map's name is on the picture, hidden from screen readers because
    // the picture's button already names the map.
    const caption = part(".game-tile-map .game-tile-map-caption");
    expect(caption?.textContent).toBeTruthy();
    expect(caption?.getAttribute("aria-hidden")).toBe("true");
    expect(part(".game-tile-body")?.textContent).not.toContain(caption?.textContent ?? "");
    // The host is the line straight under the title, captioned as the host.
    expect(part(".game-tile-host-label")?.textContent).toBe("Host:");
    expect(part(".game-tile-host")?.textContent).toBe("Host:Sui");
    expect(part(".game-tile-title")?.nextElementSibling?.classList.contains("game-tile-host")).toBe(true);
    expect(part(".game-tile-stats")?.textContent).toContain("1/4");
    expect(part(".game-tile-stats")?.textContent).toContain("Ø 1829");
    // The title has its line to itself; the age ends the bottom row.
    expect(part(".game-tile-stats > .game-tile-age")).not.toBeNull();
    expect(part(".game-tile-title")?.parentElement?.classList.contains("game-tile-body")).toBe(true);
    // The host's is the one caption the tile keeps.
    for (const caption of ["Version", "Ø Rating", "player"]) {
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
    // Half the lobby to a row, for a narrow tile that draws them in two.
    expect(big.part(".game-tile-slots")?.style.getPropertyValue("--slot-columns")).toBe("8");
    expect(mountTile({ id: 5, maxPlayers: 12 }).part(".game-tile-slots")?.style.getPropertyValue("--slot-columns")).toBe("6");
  });

  it("tags the featured mod only when it is not the tab's own", () => {
    expect(mountTile().part(".game-tile-flags")).toBeNull();
    expect(mountTile({ id: 3, modName: "coop" }).part(".game-tile-flags")).toBeNull();
    expect(mountTile({ id: 4, modName: "fafbeta" }).part(".game-tile-flags > [data-chip]")?.textContent).toBe("FAF Beta Balance");
  });

  it("puts the rating range first among the tags, where the line's clipping cannot take it", () => {
    const { part } = mountTile({ ratingMin: 1600, ratingMax: 3200, enforceRatingRange: true, modName: "fafbeta" });
    expect(part(".game-tile-stats .game-rating-range")).toBeNull();
    const range = part(".game-tile-flags > [data-chip]:first-child > *");
    expect(range?.classList.contains("game-rating-range")).toBe(true);
    expect(range?.textContent).toBe("1600-3200");
    expect(range?.classList.contains("is-enforced")).toBe(true);
  });

  // The friend set holds lowercased names, as the store builds it.
  it("tags what the game is before who is in it, and folds what does not fit into a count (#680)", () => {
    const { container } = mountTile(
      { ratingMin: 800, ratingMax: 3000, teams: { "1": ["Sui"], "2": ["Ada"] }, simMods: { roguelike: "Roguelike Mode" } },
      new Set(["ada"]),
    );
    const tags = Array.from(container.querySelectorAll(".game-tile-flags > [data-chip] > i"), (tag) => tag.className);
    expect(tags[0]).toContain("game-rating-range");
    expect(tags.indexOf("modded")).toBeGreaterThan(0);
    expect(tags.indexOf("modded")).toBeLessThan(tags.indexOf("friend"));
    // The "+N" tag is there to take over once the line is too narrow.
    expect(container.querySelector(".game-tile-flags > i.more")).not.toBeNull();
  });
});
