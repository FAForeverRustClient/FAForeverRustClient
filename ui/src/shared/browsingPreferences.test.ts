import { describe, expect, it } from "vitest";
import {
  clearLegacyBrowsingPreferences,
  DEFAULT_BROWSING_PREFERENCES,
  LEGACY_CUSTOM_GAMES_VIEW_KEY,
  LEGACY_LIVE_REPLAY_FILTERS_KEY,
  LEGACY_MATCHMAKER_FACTIONS_KEY,
  LEGACY_MATCHMAKER_QUEUES_KEY,
  migrateLegacyBrowsingPreferences,
  normalizeBrowsingPreferences,
} from "./browsingPreferences";

function memoryStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("browsing preferences", () => {
  it("normalizes with the same bounds and canonical values as Rust", () => {
    const normalized = normalizeBrowsingPreferences({
      customGamesView: "list",
      replaysView: "list",
      customGamesBrowser: {
        sort: "host",
        hidePrivate: true,
        hideModded: true,
        applyFilters: true,
        rules: [
          { field: "title", constraint: "contains", value: "  no rush  " },
          { field: "title", constraint: "contains", value: "NO RUSH" },
          { field: "map", constraint: "equals", value: "" },
        ],
      },
      matchmakerUnselectedQueues: [" ladder_1v1 ", "LADDER_1V1", ""],
      matchmakerFactions: ["cybran", "unknown"],
      liveReplayFilters: {
        search: `  ${"x".repeat(250)}  `,
        gameType: " matchmaker ",
        featuredMod: " faf ",
        activePlayers: "04",
        maxPlayers: "999",
        hideModded: true,
        hideSinglePlayer: false,
        friendsOnly: true,
      },
      hostGame: {
        title: " Friday game ",
        featuredMod: " ",
        visibility: "FRIENDS",
        map: " scmp_009 ",
        passwordEnabled: true,
        password: " secret ",
        enforceRatingRange: true,
        ratingMin: 1500,
        ratingMax: 800,
      },
      favoriteMaps: [" Adaptive_Tabula.v0006 ", "adaptive_tabula.v0006", ""],
      mapVaultPreset: "  NEWEST  ",
      modVaultPreset: "  UI  ",
      leaderboardRatingColumns: ["rating", "MEAN", "invalid_column"],
      legacyStorageMigrated: true,
    });

    expect(normalized.customGamesView).toBe("list");
    expect(normalized.replaysView).toBe("list");
    expect(normalized.matchmakerUnselectedQueues).toEqual(["ladder_1v1"]);
    expect(normalized.matchmakerFactions).toEqual(["Cybran"]);
    expect(normalized.customGamesBrowser).toMatchObject({
      sort: "host",
      hidePrivate: true,
      hideModded: true,
      applyFilters: true,
      rules: [{ field: "title", constraint: "contains", value: "no rush" }],
    });
    expect([...normalized.liveReplayFilters.search]).toHaveLength(200);
    expect(normalized.liveReplayFilters.activePlayers).toBe("4");
    expect(normalized.liveReplayFilters.maxPlayers).toBe("");
    expect(normalized.hostGame).toMatchObject({
      title: "Friday game",
      featuredMod: "faf",
      visibility: "friends",
      map: "scmp_009",
      password: " secret ",
      ratingMin: 800,
      ratingMax: 1500,
    });
    expect(normalized.favoriteMaps).toEqual(["adaptive_tabula.v0006"]);
    expect(normalized.mapVaultPreset).toBe("newest");
    expect(normalized.modVaultPreset).toBe("ui");
    expect(normalized.leaderboardRatingColumns).toEqual(["rating", "mean"]);
  });

  it("merges all four legacy keys and rejects malformed values", () => {
    const storage = memoryStorage({
      [LEGACY_CUSTOM_GAMES_VIEW_KEY]: "list",
      [LEGACY_MATCHMAKER_QUEUES_KEY]: JSON.stringify(["2v2", "2V2"]),
      [LEGACY_MATCHMAKER_FACTIONS_KEY]: JSON.stringify(["aeon"]),
      [LEGACY_LIVE_REPLAY_FILTERS_KEY]: JSON.stringify({
        search: "Aurora",
        hideModded: true,
        injected: "ignored",
        friendsOnly: "not a boolean",
      }),
    });

    const migrated = migrateLegacyBrowsingPreferences(
      DEFAULT_BROWSING_PREFERENCES,
      storage,
    );
    expect(migrated.customGamesView).toBe("list");
    expect(migrated.matchmakerUnselectedQueues).toEqual(["2v2"]);
    expect(migrated.matchmakerFactions).toEqual(["Aeon"]);
    expect(migrated.liveReplayFilters.search).toBe("Aurora");
    expect(migrated.liveReplayFilters.hideModded).toBe(true);
    expect(migrated.liveReplayFilters.friendsOnly).toBe(false);
    expect(migrated.legacyStorageMigrated).toBe(true);
  });

  it("clears only the known compatibility keys", () => {
    const storage = memoryStorage({
      [LEGACY_CUSTOM_GAMES_VIEW_KEY]: "list",
      [LEGACY_MATCHMAKER_QUEUES_KEY]: "[]",
      [LEGACY_MATCHMAKER_FACTIONS_KEY]: "[]",
      [LEGACY_LIVE_REPLAY_FILTERS_KEY]: "{}",
      unrelated: "keep",
    });
    clearLegacyBrowsingPreferences(storage);
    expect(Object.fromEntries(storage.values)).toEqual({ unrelated: "keep" });
  });
});
