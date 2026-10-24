import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplayNote, ReplayQuery, SearchPreset } from "../../ipc/bindings";
import { EMPTY_REPLAY_QUERY, isoDaysAgo } from "../../shared/replayQuery";
import { EMPTY_LOCAL_REPLAY_QUERY, type LocalReplayQuery } from "./local/localReplayQuery";
import { SHORT_GAME_MINUTES } from "./replayPresets";
import {
  decodeLocalReplayPreset,
  decodeOnlineReplayPreset,
  encodeLocalReplayPreset,
  encodeOnlineReplayPreset,
  findPresetByName,
  LOCAL_REPLAY_PRESET_LIST,
  localPresetSignature,
  ONLINE_REPLAY_PRESET_LIST,
  onlinePresetSignature,
  presetsForList,
  summarizeLocalReplayPreset,
  summarizeOnlineReplayPreset,
} from "./savedReplaySearches";

const sampleNotes: ReplayNote[] = [
  { replayId: 101, path: null, comment: "", tags: ["Cast", "Tournament"] },
  { replayId: 202, path: null, comment: "", tags: ["cast"] },
];

describe("savedReplaySearches", () => {
  it("round-trips online presets with tag names rather than ephemeral replay ids", () => {
    const query: ReplayQuery = {
      ...EMPTY_REPLAY_QUERY,
      player: "Tagada",
      map: "Seton's Clutch",
      featuredMods: ["faf"],
      leaderboards: ["ladder_1v1"],
      factions: [1, 3],
      minRating: 1800,
      maxRating: 2600,
      minDurationMinutes: SHORT_GAME_MINUTES,
      onlyRanked: true,
      replayIds: ["999"],
      sortBy: "averageRating",
      sortDescending: true,
      page: 4,
      pageSize: 25,
    };

    const raw = encodeOnlineReplayPreset(query, ["cast"]);
    expect(raw).not.toContain("999");
    expect(raw).not.toContain('"page"');

    const decoded = decodeOnlineReplayPreset(raw, sampleNotes, 100);
    expect(decoded).not.toBeNull();
    expect(decoded?.tags).toEqual(["cast"]);
    expect(decoded?.query).toEqual({
      ...query,
      replayIds: ["101", "202"],
      page: 1,
      pageSize: 100,
    });
  });

  it("keeps a non-matching replay id sentinel when a saved tag has no tagged games left", () => {
    const query: ReplayQuery = {
      ...EMPTY_REPLAY_QUERY,
      replayIds: ["101"],
    };
    const raw = encodeOnlineReplayPreset(query, ["retired-tag"]);

    const decoded = decodeOnlineReplayPreset(raw, sampleNotes, 50);
    expect(decoded?.tags).toEqual(["retired-tag"]);
    expect(decoded?.query.replayIds).toEqual(["0"]);
  });

  it("fills missing fields from defaults and rejects malformed JSON", () => {
    expect(decodeOnlineReplayPreset("not json", [], 50)).toBeNull();
    expect(decodeOnlineReplayPreset("[]", [], 50)).toBeNull();
    expect(decodeLocalReplayPreset("{broken")).toBeNull();

    const online = decodeOnlineReplayPreset(
      JSON.stringify({ map: "Dual Gap", sortBy: "unknownField" }),
      [],
      50,
    );
    expect(online?.query).toEqual({
      ...EMPTY_REPLAY_QUERY,
      map: "Dual Gap",
      page: 1,
      pageSize: 50,
    });

    const local = decodeLocalReplayPreset(
      JSON.stringify({ player: "Sheikah", status: "notAStatus", sortBy: "notASort" }),
    );
    expect(local).toEqual({
      ...EMPTY_LOCAL_REPLAY_QUERY,
      player: "Sheikah",
    });
  });

  it("computes signatures independent of paging, tag case, and whitespace", () => {
    const first: ReplayQuery = {
      ...EMPTY_REPLAY_QUERY,
      player: "  Tagada ",
      factions: [3, 1],
      replayIds: ["101"],
      page: 1,
      pageSize: 25,
    };
    const second: ReplayQuery = {
      ...EMPTY_REPLAY_QUERY,
      player: "Tagada",
      factions: [1, 3],
      replayIds: ["101", "202"],
      page: 3,
      pageSize: 100,
    };

    expect(onlinePresetSignature(first, ["Tournament", "cast"])).toBe(
      onlinePresetSignature(second, ["CAST", "tournament"]),
    );

    const localA: LocalReplayQuery = {
      ...EMPTY_LOCAL_REPLAY_QUERY,
      map: " Astro Crater ",
      tags: ["Review", "1v1"],
    };
    const localB: LocalReplayQuery = {
      ...EMPTY_LOCAL_REPLAY_QUERY,
      map: "Astro Crater",
      tags: ["1v1", "review"],
    };
    expect(localPresetSignature(localA)).toBe(localPresetSignature(localB));
  });

  it("filters presets per list and finds names case-insensitively", () => {
    const presets: SearchPreset[] = [
      { list: ONLINE_REPLAY_PRESET_LIST, name: "High Ladder", query: "{}" },
      { list: LOCAL_REPLAY_PRESET_LIST, name: "Tournament", query: "{}" },
    ];

    const onlineOnly = presetsForList(presets, ONLINE_REPLAY_PRESET_LIST);
    expect(onlineOnly.map((entry) => entry.name)).toEqual(["High Ladder"]);
    expect(findPresetByName(onlineOnly, "  high ladder ")).toEqual(presets[0]);
    expect(findPresetByName(onlineOnly, "Tournament")).toBeNull();
  });

  describe("date windows computed from today", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keep meaning the last year or three, not the day they were saved", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
      const online = encodeOnlineReplayPreset({ ...EMPTY_REPLAY_QUERY, after: isoDaysAgo(365) }, []);
      const best = encodeOnlineReplayPreset({ ...EMPTY_REPLAY_QUERY, after: isoDaysAgo(365 * 3) }, []);
      const local = encodeLocalReplayPreset({ ...EMPTY_LOCAL_REPLAY_QUERY, after: isoDaysAgo(365) });
      const picked = encodeOnlineReplayPreset({ ...EMPTY_REPLAY_QUERY, after: "2026-03-01" }, []);
      expect(online).toContain('"afterDays":365');
      expect(online).not.toContain('"after"');
      expect(best).toContain('"afterDays":1095');
      expect(local).toContain('"afterDays":365');
      // A date the user picked is a date.
      expect(picked).toContain('"after":"2026-03-01"');

      vi.setSystemTime(new Date("2027-04-23T12:00:00Z"));
      expect(decodeOnlineReplayPreset(online, [], 50)?.query.after).toBe("2026-04-23");
      expect(decodeOnlineReplayPreset(best, [], 50)?.query.after).toBe("2024-04-23");
      expect(decodeLocalReplayPreset(local)?.after).toBe("2026-04-23");
      expect(decodeOnlineReplayPreset(picked, [], 50)?.query.after).toBe("2026-03-01");
      expect(summarizeOnlineReplayPreset(decodeOnlineReplayPreset(online, [], 50)!, [])).toContain("Last year");
      expect(summarizeOnlineReplayPreset(decodeOnlineReplayPreset(best, [], 50)!, [])).toContain("Last 3 years");
      expect(summarizeOnlineReplayPreset(decodeOnlineReplayPreset(picked, [], 50)!, [])).toContain("from 2026-03-01");
    });
  });

  it("summarizes online and local presets concisely", () => {
    const defaultOnline = decodeOnlineReplayPreset("{}", [], 50)!;
    expect(summarizeOnlineReplayPreset(defaultOnline, [])).toContain("All replays");

    const richOnline = decodeOnlineReplayPreset(
      encodeOnlineReplayPreset(
        {
          ...EMPTY_REPLAY_QUERY,
          player: "Tagada",
          map: "Seton's Clutch",
          minRating: 1800,
          minDurationMinutes: SHORT_GAME_MINUTES,
          replayIds: ["101"],
          onlyRanked: true,
        },
        ["cast"],
      ),
      sampleNotes,
      50,
    )!;
    const onlineSummary = summarizeOnlineReplayPreset(richOnline, []);
    expect(onlineSummary).toContain("Tagada");
    expect(onlineSummary).toContain("Seton's Clutch");
    expect(onlineSummary).toContain("1800+");
    expect(onlineSummary).toContain("Skip short games");
    expect(onlineSummary).toContain("#cast");
    expect(onlineSummary).toContain("Ranked games only");

    const richLocal = decodeLocalReplayPreset(
      encodeLocalReplayPreset({
        ...EMPTY_LOCAL_REPLAY_QUERY,
        map: " Isis ",
        gameMode: "ladder_1v1",
        minDurationMinutes: SHORT_GAME_MINUTES,
        onlyWatchable: true,
        sortBy: "players",
        sortDescending: false,
      }),
    )!;
    const localSummary = summarizeLocalReplayPreset(richLocal);
    expect(localSummary).toContain("Isis");
    expect(localSummary).toContain("1v1");
    expect(localSummary).toContain("Skip short games");
    expect(localSummary).toContain("Watchable files only");
    expect(localSummary).toContain("Player count ↑");
  });
});
