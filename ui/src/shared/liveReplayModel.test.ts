import { describe, expect, it } from "vitest";
import type { Game } from "../ipc/bindings";
import {
  DEFAULT_LIVE_FILTERS,
  filterChoices,
  joinFilterChoices,
  liveFeaturedModOptions,
  matchesFilterChoice,
  parseLiveFilters,
  prettyFeaturedMod,
} from "./liveReplayModel";

describe("live replay filter persistence", () => {
  it("accepts only expected fields with the expected primitive types", () => {
    expect(parseLiveFilters({
      search: "ranked",
      hideModded: true,
      maxPlayers: 12,
      friendsOnly: "yes",
      injected: "ignored",
    })).toEqual({
      ...DEFAULT_LIVE_FILTERS,
      search: "ranked",
      hideModded: true,
    });
  });

  it.each([null, [], "filters", 42])("falls back for non-record value %p", (value) => {
    expect(parseLiveFilters(value)).toEqual(DEFAULT_LIVE_FILTERS);
  });
});

describe("the featured mod filter", () => {
  const game = (modName: string) => ({ modName }) as Game;

  it("leaves co-op to the game type filter", () => {
    // Both dropdowns offered the same games, spelled "Co-op" in one and
    // "coop" in the other, which read as two different sections.
    expect(liveFeaturedModOptions([game("faf"), game("coop"), game("Coop")]))
      .toEqual(["faf"]);
  });

  it("offers every other mod the server is actually running", () => {
    expect(liveFeaturedModOptions([game("nomads"), game("faf"), game("faf"), game("")]))
      .toEqual(["faf", "nomads"]);
  });

  it("spells a known mod the way the host dialog does", () => {
    expect(prettyFeaturedMod("faf")).toBe("FAF");
    expect(prettyFeaturedMod("nomads")).toBe("Nomads");
    // An unknown technical name is capitalised, never invented.
    expect(prettyFeaturedMod("murderparty")).toBe("Murderparty");
  });
});

describe("filters holding several choices", () => {
  it("reads an older single saved value as one choice", () => {
    expect(filterChoices("custom")).toEqual(["custom"]);
    expect(filterChoices("")).toEqual([]);
  });

  it("keeps each choice once and drops empty ones", () => {
    expect(filterChoices(" custom,,matchmaker ,custom")).toEqual(["custom", "matchmaker"]);
    expect(joinFilterChoices(["custom", "matchmaker", "custom"])).toBe("custom,matchmaker");
  });

  it("passes a game matching any choice, and every game when none is chosen", () => {
    expect(matchesFilterChoice("custom,matchmaker", "matchmaker")).toBe(true);
    expect(matchesFilterChoice("custom,matchmaker", "coop")).toBe(false);
    expect(matchesFilterChoice("2,4", 4)).toBe(true);
    expect(matchesFilterChoice("", "coop")).toBe(true);
  });

  it("stores player counts as a list, dropping only the bad entries", () => {
    expect(parseLiveFilters({ activePlayers: "2, 04,abc,999,2" }).activePlayers).toBe("2,4");
  });
});
