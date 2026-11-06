// @vitest-environment happy-dom
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ClientNotification, Game, MapSummary, TourneyMap, VaultReplay } from "../../ipc/bindings";
import { clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { useAppStore } from "../../store/store";
import { toggleFavoriteMap } from "../../shared/favoriteMaps";
import { mapDownloadUrl, mapThumbnailUrl } from "../../shared/mapCatalogue";
import { tourneyMapImage } from "../../shared/rules/tourneyRules";
import { GamePreviewDialog } from "../lobby/browser/GamePreviewDialog";
import { useReplayMapPreparation } from "../replays/useReplayMapPreparation";
import { notificationArtwork } from "../notifications/notificationArtwork";

vi.mock("../../ipc/client");
failOnConsoleError();

const map: MapSummary = {
  mapId: 1, versionId: 2, displayName: "Compact map", author: null, authorId: null,
  folderName: "compact_map.v0002", version: "2", description: "Original description",
  mapType: "skirmish", maxPlayers: 4, width: 512, height: 512, gamesPlayed: 10,
  versionGamesPlayed: 5, ranked: true, hidden: false, recommended: false, ratingTenths: 40,
  reviews: 3, createdAt: "2026-01-02T00:00:00Z",
};
const game: Game = {
  id: 42, title: "A game", host: "Host", players: 1, maxPlayers: 4, map: map.folderName,
  modName: "faf", averageRating: 1500, ratingType: "global", passwordProtected: false,
  visibility: "public", gameType: "custom", launchedAt: null, hostedAt: null,
  ratingMin: null, ratingMax: null, enforceRatingRange: false, teams: {}, simMods: {},
};
const replay: VaultReplay = {
  uid: 42, title: "A replay", map: map.folderName, mapThumbnailUrl: "", modName: "faf",
  startTime: "2026-01-02T00:00:00Z", replayAvailable: true, durationSeconds: 1200,
  gameDurationSeconds: 1100, teams: [], averageRating: 1500, quality: 80,
  reviewsAverage: null, reviewsCount: null, gameVersion: null,
};

function seed(entry: MapSummary) {
  seedStore((state) => ({ ...state, maps: { ...state.maps, vault: [entry], vaultStatus: { type: "ready" } }, lobby: { ...state.lobby, games: [game] } }));
  clearSentCommands();
}

function expectDownload(entry: MapSummary) {
  expect(sentCommands().filter((command) => command.kind === "Maps" && command.command.type === "installMap"))
    .toEqual([{ kind: "Maps", command: { type: "installMap", payload: { folderName: entry.folderName, downloadUrl: mapDownloadUrl(entry) } } }]);
}

describe.each([
  { label: "canonical", entry: map },
  { label: "custom", entry: { ...map, urls: { downloadUrl: "https://other.invalid/archive.zip", thumbnailUrl: "https://other.invalid/small.png", thumbnailUrlLarge: "https://other.invalid/large.png" } } },
])("$label compact catalogue actions", ({ entry }) => {
  it("downloads a newly starred map using the catalogue URL", () => {
    seed(entry);
    act(() => toggleFavoriteMap(entry.folderName));
    expectDownload(entry);
  });

  it("downloads the map from game details", async () => {
    const user = userEvent.setup();
    seed(entry);
    render(<GamePreviewDialog game={game} vault={[entry]} onClose={() => undefined} onJoin={() => undefined} />);
    clearSentCommands();
    await user.click(screen.getByRole("button", { name: "Download map" }));
    expectDownload(entry);
  });

  it("downloads the map from replay preparation", () => {
    seed(entry);
    const { result } = renderHook(() => useReplayMapPreparation({ replay, localMatch: undefined }));
    expect(result.current.downloadMap).not.toBeNull();
    act(() => result.current.downloadMap?.());
    expectDownload(entry);
    expect(result.current.presentation.displayName).toBe(entry.displayName);
  });

  it("keeps notification and tournament artwork", () => {
    seed(entry);
    const notification = { action: { type: "openGame", payload: { gameId: game.id } } } as ClientNotification;
    const tournamentMap = { name: entry.displayName, imageUrl: "" } as TourneyMap;
    expect(notificationArtwork(notification, useAppStore.getState().state)).toBe(mapThumbnailUrl(entry));
    expect(tourneyMapImage(tournamentMap, "", [entry])).toBe(mapThumbnailUrl(entry));
  });
});
