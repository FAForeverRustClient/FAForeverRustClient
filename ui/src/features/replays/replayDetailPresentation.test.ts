import { describe, expect, it } from "vitest";

import type { LocalReplay } from "../../ipc/bindings";
import { GENERATED_MAP_PLACEHOLDER_URL } from "../../shared/mapPresentation";
import {
  generatedPreviewFor,
  generatorProgress,
  heatmapPreviewUrl,
  isGeneratorRunning,
  isMapInstalled,
  localReplayToVaultReplay,
} from "./replayDetailPresentation";

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

function localReplay(fields: Partial<LocalReplay> = {}): LocalReplay {
  return {
    path: "replays/game.fafreplay",
    fileName: "game.fafreplay",
    uid: 42,
    map: "",
    modName: "",
    title: "",
    recorder: "someone",
    startTime: null,
    durationSeconds: null,
    modifiedTime: 0,
    fileSizeBytes: 0,
    numPlayers: 2,
    teams: [],
    averageRating: null,
    simMods: [],
    status: "complete",
    watchable: true,
    gameVersion: null,
    ...fields,
  };
}

describe("localReplayToVaultReplay", () => {
  it("falls back to the file name for the title and map, and to faf for the mod", () => {
    const replay = localReplayToVaultReplay(localReplay(), []);
    expect(replay).toMatchObject({ uid: 42, title: "game.fafreplay", map: "game.fafreplay", modName: "faf" });
    expect(replay.startTime).toBe("");
    expect(replay.replayAvailable).toBe(true);
  });

  it("reads the team number, with the observers' null as -1", () => {
    const replay = localReplayToVaultReplay(
      localReplay({
        uid: null,
        teams: [
          { team: "2", players: [{ name: "a", faction: 1, rating: 1500 }] },
          { team: "null", players: [{ name: "b", faction: null, rating: null, country: "DE" }] },
        ],
      }),
      [],
    );
    expect(replay.uid).toBe(0);
    expect(replay.teams.map((team) => team.team)).toEqual([2, -1]);
    expect(replay.teams[1].players[0]).toEqual({
      name: "b",
      faction: null,
      rating: null,
      country: "DE",
      outcome: "",
      score: null,
    });
  });
});

describe("generatedPreviewFor", () => {
  it("finds a preview stored under the name as given or lower-cased", () => {
    expect(generatedPreviewFor({ Foo_Map: "a" }, "Foo_Map")).toBe("a");
    expect(generatedPreviewFor({ foo_map: "b" }, "FOO_MAP")).toBe("b");
    expect(generatedPreviewFor(undefined, "foo")).toBeUndefined();
  });
});

describe("isMapInstalled", () => {
  const installed = [{ folderName: "Canis.v0002", displayName: "Canis" }];

  it("matches the folder itself or any version of it, ignoring case", () => {
    expect(isMapInstalled(installed, "canis.v0002")).toBe(true);
    expect(isMapInstalled(installed, "canis")).toBe(true);
    expect(isMapInstalled(installed, "can")).toBe(false);
  });
});

describe("generator status", () => {
  it("counts every step between asking and finishing as running", () => {
    expect(isGeneratorRunning({ type: "preparing" })).toBe(true);
    expect(isGeneratorRunning({ type: "resolvingVersion" })).toBe(true);
    expect(isGeneratorRunning({ type: "generating", payload: { version: "1", detail: "" } })).toBe(true);
    expect(isGeneratorRunning({ type: "idle" })).toBe(false);
  });

  it("describes a download with its byte fraction when the size is known", () => {
    expect(
      generatorProgress(
        { type: "downloading", payload: { version: "1.2", downloadedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 } },
        t,
      ),
    ).toEqual({ label: 'replays.detail.downloadingGenerator {"version":"1.2"} (1.0/4.0 MB)', percent: 25 });
    expect(
      generatorProgress({ type: "downloading", payload: { version: "1.2", downloadedBytes: 5, totalBytes: null } }, t),
    ).toEqual({ label: 'replays.detail.downloadingGenerator {"version":"1.2"}', percent: null });
  });

  it("uses the generator's own line while it runs, and a generic one when it is blank", () => {
    expect(generatorProgress({ type: "generating", payload: { version: "1", detail: "Placing mexes" } }, t))
      .toEqual({ label: "Placing mexes", percent: null });
    expect(generatorProgress({ type: "generating", payload: { version: "1", detail: "  " } }, t))
      .toEqual({ label: "lobby.details.generatingMap", percent: null });
    expect(generatorProgress({ type: "idle" }, t)).toBeNull();
  });
});

describe("heatmapPreviewUrl", () => {
  it("prefers a generated preview, then a real thumbnail, and never the placeholder", () => {
    expect(heatmapPreviewUrl("data:generated", "https://example/thumb.png")).toBe("data:generated");
    expect(heatmapPreviewUrl(undefined, "https://example/thumb.png")).toBe("https://example/thumb.png");
    expect(heatmapPreviewUrl(undefined, GENERATED_MAP_PLACEHOLDER_URL)).toBeUndefined();
    expect(heatmapPreviewUrl(undefined, "")).toBeUndefined();
  });
});
