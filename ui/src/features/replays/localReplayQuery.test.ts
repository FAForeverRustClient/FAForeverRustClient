import { describe, expect, it } from "vitest";
import type { LocalReplay } from "../../ipc/bindings";
import {
  EMPTY_LOCAL_REPLAY_QUERY,
  filterLocalReplays,
  nextLocalDetailLimit,
  type LocalReplayQuery,
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
    durationSeconds: 1_530,
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
    gameVersion: null,
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

    // The default is exact, so a partial name matches nobody: "test" is not the
    // player, "TestPlayer" is. Unticking the box is what widens it again.
    expect(filterLocalReplays([candidate], query)).toEqual([]);
    expect(filterLocalReplays([candidate], { ...query, exactPlayer: false })).toEqual([candidate]);

    // Multi-player search: matches only games where ALL listed players participated
    expect(
      filterLocalReplays([candidate], {
        ...EMPTY_LOCAL_REPLAY_QUERY,
        player: "TestPlayer, Foley",
        exactPlayer: true,
      }),
    ).toEqual([candidate]);
    expect(
      filterLocalReplays([candidate], {
        ...EMPTY_LOCAL_REPLAY_QUERY,
        player: "TestPlayer, SomeoneElse",
        exactPlayer: true,
      }),
    ).toEqual([]);
  });

  // The options overlap on purpose: a custom 3v3 is both a custom game and a
  // 3v3, and the file says both. See `localGameModes` for why picking one
  // bucket per replay would be worse.
  it("answers the mode a replay was played in from its mod and its roster", () => {
    const sides = (a: number, b: number) => [
      { team: "2", players: Array.from({ length: a }, (_, i) => ({ name: `left${i}`, faction: null, rating: null })) },
      { team: "3", players: Array.from({ length: b }, (_, i) => ({ name: `right${i}`, faction: null, rating: null })) },
    ];
    const custom3v3 = replay({ path: "C:/replays/1.fafreplay", modName: "faf", teams: sides(3, 3) });
    const beta2v2 = replay({ path: "C:/replays/2.fafreplay", modName: "fafbeta", teams: sides(2, 2) });
    const coop = replay({ path: "C:/replays/3.fafreplay", modName: "coop", teams: sides(4, 4) });
    const ladder = replay({ path: "C:/replays/4.fafreplay", modName: "ladder1v1", teams: sides(1, 1) });
    const uneven = replay({ path: "C:/replays/5.fafreplay", modName: "faf", teams: sides(3, 2) });
    const all = [custom3v3, beta2v2, coop, ladder, uneven];
    const matching = (gameMode: LocalReplayQuery["gameMode"]) =>
      filterLocalReplays(all, { ...EMPTY_LOCAL_REPLAY_QUERY, gameMode }).map((r) => r.path);

    expect(matching("")).toHaveLength(5);
    // Every build of the base mod is a custom game; only co-op and ladder are not.
    expect(matching("custom")).toEqual([
      "C:/replays/1.fafreplay", "C:/replays/2.fafreplay", "C:/replays/5.fafreplay",
    ]);
    expect(matching("tmm_3v3")).toEqual(["C:/replays/1.fafreplay"]);
    expect(matching("tmm_2v2")).toEqual(["C:/replays/2.fafreplay"]);
    expect(matching("coop")).toEqual(["C:/replays/3.fafreplay"]);
    expect(matching("ladder_1v1")).toEqual(["C:/replays/4.fafreplay"]);
    // A four-a-side co-op roster is a team against the map, not a 4v4.
    expect(matching("tmm_4v4_full_share")).toEqual([]);
  });

  // An unread row has no roster, and a size guessed for it is a size invented.
  it("puts a replay with no readable roster in no size at all", () => {
    const unread = replay({ path: "C:/replays/9.fafreplay", modName: "faf", teams: [] });

    expect(filterLocalReplays([unread], { ...EMPTY_LOCAL_REPLAY_QUERY, gameMode: "tmm_3v3" }))
      .toEqual([]);
    expect(filterLocalReplays([unread], { ...EMPTY_LOCAL_REPLAY_QUERY, gameMode: "custom" }))
      .toEqual([unread]);
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
});

describe("local replay detail window", () => {
  // The shape the backend returns: every file listed, the newest `read` of
  // them with their headers parsed and the rest carrying nothing but a name.
  const archive = (count: number, read: number) =>
    Array.from({ length: count }, (_, index) => index < read
      ? replay({ path: `C:/replays/${index}.fafreplay` })
      : replay({
        path: `C:/replays/${index}.fafreplay`,
        status: "unread",
        title: "",
        map: "",
        uid: null,
        teams: [],
      }));

  it("asks for enough headers to cover a page the reader jumped to", () => {
    const all = archive(3000, 360);
    // Page 11 with a page size of 36 starts at entry 360: the first row the
    // last run stopped short of.
    const page = all.slice(360, 396);
    expect(nextLocalDetailLimit({ all, page, detailLimit: 360, atLastPage: false, batch: 360 }))
      .toBe(720);
  });

  it("covers a page far past the loaded window in one request", () => {
    const all = archive(3000, 360);
    const page = all.slice(2160, 2196);
    expect(nextLocalDetailLimit({ all, page, detailLimit: 360, atLastPage: false, batch: 360 }))
      .toBe(2196);
  });

  it("leaves a fully read page alone", () => {
    const all = archive(3000, 360);
    expect(nextLocalDetailLimit({
      all,
      page: all.slice(0, 36),
      detailLimit: 360,
      atLastPage: false,
      batch: 360,
    })).toBeNull();
  });

  it("still fetches ahead on the last page, where a filter hides the unread rows", () => {
    const all = archive(3000, 360);
    expect(nextLocalDetailLimit({
      all,
      page: all.slice(324, 360),
      detailLimit: 360,
      atLastPage: true,
      batch: 360,
    })).toBe(720);
  });

  it("stops once every header in the folder has been read", () => {
    const all = archive(300, 300);
    expect(nextLocalDetailLimit({
      all,
      page: all.slice(0, 36),
      detailLimit: 360,
      atLastPage: true,
      batch: 360,
    })).toBeNull();
  });

  it("never asks for more than the folder holds", () => {
    const all = archive(500, 360);
    expect(nextLocalDetailLimit({
      all,
      page: all.slice(464, 500),
      detailLimit: 360,
      atLastPage: true,
      batch: 360,
    })).toBe(500);
  });
});
