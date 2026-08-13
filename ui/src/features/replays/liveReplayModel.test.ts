import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_FILTERS, parseLiveFilters } from "./liveReplayModel";

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
