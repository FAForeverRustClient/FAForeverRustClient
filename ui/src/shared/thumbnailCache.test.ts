import { afterEach, describe, expect, it } from "vitest";
import {
  firstLiveCandidate,
  markThumbnailMissing,
  resetMissingThumbnails,
} from "./thumbnailCache";

afterEach(() => {
  resetMissingThumbnails();
});

// What a co-op mission's tile is handed: the API composes these from the map
// folder name, and the content server has none of them.
const CANDIDATES = [
  "https://content.faforever.com/maps/previews/small/scca_coop_r02.v0009.png",
  "https://content.faforever.com/maps/previews/large/scca_coop_r02.v0009.png",
];

describe("thumbnail candidate cache", () => {
  it("starts at the first candidate while nothing is known to be missing", () => {
    expect(firstLiveCandidate(CANDIDATES)).toBe(0);
  });

  it("skips straight past a miss on the next mount", () => {
    markThumbnailMissing(CANDIDATES[0]);
    // The reported bug: without this the roster remounted at index 0 and
    // rendered the broken image again before walking on, once per tab switch.
    expect(firstLiveCandidate(CANDIDATES)).toBe(1);
  });

  it("reports exhaustion so the caller can go straight to local art", () => {
    CANDIDATES.forEach(markThumbnailMissing);
    expect(firstLiveCandidate(CANDIDATES)).toBe(CANDIDATES.length);
  });

  it("keeps a remembered miss out of an unrelated map's walk", () => {
    markThumbnailMissing(CANDIDATES[0]);
    expect(firstLiveCandidate(["https://content.faforever.com/maps/previews/small/theta.png"])).toBe(0);
  });
});
