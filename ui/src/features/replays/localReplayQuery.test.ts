import { describe, expect, it } from "vitest";
import type { LocalReplay } from "../../ipc/bindings";
import {
  EMPTY_LOCAL_REPLAY_QUERY,
  filterLocalReplays,
  personalLocalReplayQuery,
} from "./localReplayQuery";

function replay(overrides: Partial<LocalReplay> = {}): LocalReplay {
  return {
    path: "C:/replays/101.fafreplay",
    fileName: "101.fafreplay",
    uid: 101,
    map: "Seton's Clutch",
    modName: "faf",
    title: "Team game",
    recorder: "TestPlayer",
    startTime: 1_767_225_600,
    modifiedTime: 1_767_225_600,
    fileSizeBytes: 25_000,
    numPlayers: 4,
    teams: [{ team: "2", players: [
      { name: "TestPlayer", faction: null, rating: null },
      { name: "Foley", faction: null, rating: null },
    ] }],
    averageRating: null,
    simMods: ["Balance mod"],
    status: "complete",
    watchable: true,
    ...overrides,
  };
}

describe("local replay query", () => {
  it("applies the same player, map, replay id, and mod fields as online search", () => {
    const candidate = replay();
    const query = {
      ...EMPTY_LOCAL_REPLAY_QUERY,
      player: "test",
      map: "seton",
      replayId: "#101",
      mod: "FAF",
    };

    expect(filterLocalReplays([candidate], query)).toEqual([candidate]);
    expect(filterLocalReplays([candidate], { ...query, exactPlayer: true })).toEqual([]);
  });

  it("supports local advanced filters and sort direction", () => {
    const older = replay();
    const newer = replay({
      path: "C:/replays/202.fafreplay",
      fileName: "202.fafreplay",
      uid: 202,
      title: "Newer game",
      startTime: 1_770_000_000,
      modifiedTime: 1_770_000_000,
    });
    const query = {
      ...EMPTY_LOCAL_REPLAY_QUERY,
      recorder: "testplayer",
      simMod: "balance",
      onlyWatchable: true,
    };

    expect(filterLocalReplays([older, newer], query).map((item) => item.uid)).toEqual([202, 101]);
    expect(filterLocalReplays([older, newer], { ...query, sortDescending: false }).map((item) => item.uid)).toEqual([101, 202]);
  });

  it("filters local replays by the visible rating range", () => {
    const high = replay({ averageRating: 1450 });
    const low = replay({ path: "C:/replays/202.fafreplay", averageRating: 850 });

    expect(filterLocalReplays([high, low], {
      ...EMPTY_LOCAL_REPLAY_QUERY,
      minRating: 1000,
      maxRating: 1600,
    })).toEqual([high]);
  });

  it("builds an exact personal preset", () => {
    expect(personalLocalReplayQuery("TestPlayer")).toMatchObject({
      player: "TestPlayer",
      exactPlayer: true,
    });
  });
});
