// @vitest-environment happy-dom
//
// A page of replay cards where some of the lookups behind them fail: one map
// has vault art, one has none anywhere until the vault is asked about its
// folder, and one replay has not been uploaded yet. Every card still shows,
// the healthy ones untouched, the failed art as a placeholder and then as the
// vault's art once the folder lookup answers, and the unfinished replay
// without a Watch button.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultMap, VaultReplay } from "../../ipc/bindings";
import { resetVaultFolderLookups } from "../../shared/hooks/useVaultFolderLookup";
import { resetMissingThumbnails } from "../../shared/thumbnailCache";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../testing/mounted";
import { ReplayCard } from "./ReplayCard";

vi.mock("../../ipc/client");

failOnConsoleError();

beforeEach(() => {
  // Both remember what failed for the whole session, at module level.
  resetMissingThumbnails();
  resetVaultFolderLookups();
});

function vaultReplay(uid: number, title: string, map: string, overrides: Partial<VaultReplay> = {}): VaultReplay {
  return {
    uid,
    title,
    map,
    mapThumbnailUrl: "",
    modName: "faf",
    startTime: "2026-01-02T18:00:00Z",
    replayAvailable: true,
    durationSeconds: 1_200,
    gameDurationSeconds: 1_100,
    teams: [],
    averageRating: 1_500,
    quality: 80,
    reviewsAverage: null,
    reviewsCount: null,
    gameVersion: null,
    ...overrides,
  };
}

function vaultMap(versionId: number, folderName: string, displayName: string): VaultMap {
  return {
    mapId: versionId,
    versionId,
    displayName,
    author: "Mapper",
    authorId: null,
    folderName,
    version: "1",
    description: "",
    mapType: "skirmish",
    maxPlayers: 4,
    width: 512,
    height: 512,
    gamesPlayed: 0,
    versionGamesPlayed: 0,
    ranked: true,
    hidden: false,
    recommended: false,
    ratingTenths: 0,
    reviews: 0,
    createdAt: "2025-01-01T00:00:00Z",
    downloadUrl: "",
    thumbnailUrl: `https://content.example/small/${folderName}.png`,
    thumbnailUrlLarge: `https://content.example/large/${folderName}.png`,
  };
}

const replays = [
  vaultReplay(1, "Healthy game", "setons_clutch.v0002"),
  vaultReplay(2, "Withdrawn game", "withdrawn_map.v0004"),
  vaultReplay(3, "Processing game", "setons_clutch.v0002", { replayAvailable: false }),
];

function mountCards() {
  seedStore((state) => ({
    ...state,
    maps: {
      ...state.maps,
      vault: [vaultMap(10, "setons_clutch.v0002", "Seton's Clutch")],
      vaultStatus: { type: "ready" },
    },
  }));
  render(
    <>
      {replays.map((replay) => (
        <ReplayCard key={replay.uid} replay={replay} watched={false} onOpen={() => undefined} onWatch={() => undefined} />
      ))}
    </>,
  );
}

const cardOf = (title: string) => {
  const card = screen.getByText(title).closest<HTMLElement>(".replay-card");
  if (!card) throw new Error(`no card for ${title}`);
  return card;
};

/** Fail every remote picture the card tries, as a 404 would, and return what it tried. */
function failEveryPicture(card: HTMLElement): string[] {
  const tried: string[] = [];
  for (let step = 0; step < 10; step += 1) {
    const image = within(card).queryByRole("img");
    if (!image) return tried;
    tried.push(image.getAttribute("src") ?? "");
    fireEvent.error(image);
  }
  throw new Error("the thumbnail never ran out of candidates");
}

describe("Replay cards with partial lookups, mounted", () => {
  it("keeps the healthy cards, falls back for the failed art and asks the vault about that folder once", async () => {
    mountCards();
    expect(within(cardOf("Healthy game")).getByRole("img").getAttribute("src"))
      .toBe("https://content.example/small/setons_clutch.v0002.png");

    const withdrawn = cardOf("Withdrawn game");
    const tried = failEveryPicture(withdrawn);
    expect(tried.length).toBeGreaterThan(0);
    expect(within(withdrawn).getByLabelText(/preview unavailable$/)).toBeTruthy();

    // The healthy card was not disturbed by its neighbour's failures.
    expect(within(cardOf("Healthy game")).getByRole("img").getAttribute("src"))
      .toBe("https://content.example/small/setons_clutch.v0002.png");

    // One batched lookup, for the folder that ran out of art and nothing else.
    await waitFor(() => {
      expect(sentCommands().filter((command) => command.kind === "Maps")).toEqual([
        { kind: "Maps", command: { type: "resolveVaultFolders", payload: { folderNames: ["withdrawn_map.v0004"] } } },
      ]);
    });

    applyEvent({
      kind: "Maps",
      event: { type: "vaultFoldersResolved", payload: { maps: [vaultMap(20, "withdrawn_map.v0004", "Withdrawn Map")] } },
    });
    expect(within(withdrawn).getByRole("img").getAttribute("src"))
      .toBe("https://content.example/small/withdrawn_map.v0004.png");
  });

  it("shows a replay that has not been uploaded yet without a Watch button, beside ones that have", () => {
    mountCards();
    expect(within(cardOf("Processing game")).getByText("not uploaded yet")).toBeTruthy();
    expect(within(cardOf("Processing game")).queryByRole("button", { name: /^Watch/ })).toBeNull();
    expect(within(cardOf("Healthy game")).getByRole("button", { name: "Watch Healthy game" })).toBeTruthy();
    expect(within(cardOf("Withdrawn game")).getByRole("button", { name: "Watch Withdrawn game" })).toBeTruthy();
  });
});
