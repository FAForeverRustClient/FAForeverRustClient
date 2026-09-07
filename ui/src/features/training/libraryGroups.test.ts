import { describe, expect, it } from "vitest";

import { collectionsOf } from "./libraryGroups";
import type { TrainingProfile, TrainingResource } from "../../ipc/bindings";

const base: TrainingResource = {
  id: "",
  title: "",
  summary: "",
  kind: "guide",
  level: null,
  imageUrl: "",
  url: "",
  recordingUrl: "",
  readable: false,
  tutorialId: null,
  author: "",
  ratingMin: null,
  ratingMax: null,
  gameModes: [],
  topics: [],
  maps: [],
  factions: [],
  durationMinutes: null,
  related: [],
  approvedBy: "",
  updatedAt: "",
};

const entry = (over: Partial<TrainingResource>): TrainingResource => ({
  ...base,
  ...over,
  id: over.id ?? over.title ?? "",
});

const profile = (over: Partial<TrainingProfile> = {}): TrainingProfile => ({
  player: "Ada",
  rating: null,
  ratings: {},
  maps: [],
  gameModes: [],
  factions: [],
  gamesSeen: 0,
  ...over,
});

const ladder = [
  entry({ title: "Twin Rivers", kind: "buildOrder", gameModes: ["1v1"], maps: ["Twin Rivers"] }),
  entry({ title: "Arcane", kind: "buildOrder", gameModes: ["1v1"], maps: ["Arcane"] }),
  entry({ title: "Open Palms", kind: "buildOrder", gameModes: ["1v1"], maps: ["Open Palms"] }),
];
const team = [
  entry({ title: "Seton's beach", kind: "buildOrder", gameModes: ["custom", "4v4"] }),
  entry({ title: "Seton's air", kind: "buildOrder", gameModes: ["custom", "4v4"] }),
];

describe("collectionsOf", () => {
  it("shelves by mode rather than by who wrote it", () => {
    // Whose build order it is is a fact about the entry, not a reason to file
    // it: a player looking for one is looking for a build order for 1v1.
    const byBully = entry({ title: "Cobalt Valley", author: "Bullydozer", gameModes: ["1v1"] });
    const bySladow = entry({ title: "Red Rocks", author: "Sladow-Noob", gameModes: ["1v1"] });
    const groups = collectionsOf([byBully, bySladow], profile());
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("1v1");
  });

  it("names a team shelf by its shape, not by where it is hosted", () => {
    // Every entry in the catalogue that says "custom" also says "4v4": the
    // first answers where the game is hosted, the second what it is.
    const [group] = collectionsOf(team, profile());
    expect(group.key).toBe("4v4");
  });

  it("puts an entry on one shelf even when it names several modes", () => {
    // The same card under two headings is the same card twice on one screen,
    // and the mode filter above already finds it under either.
    const groups = collectionsOf([...ladder, ...team], profile());
    expect(groups.flatMap((group) => group.entries)).toHaveLength(5);
  });

  it("puts the modes this player has been playing first", () => {
    const groups = collectionsOf([...team, ...ladder], profile({ gameModes: ["1v1"] }));
    expect(groups.map((group) => group.key)).toEqual(["1v1", "4v4"]);
  });

  it("falls back to the fuller shelf when the player has played neither", () => {
    const groups = collectionsOf([...team, ...ladder], profile());
    expect(groups.map((group) => group.key)).toEqual(["1v1", "4v4"]);
  });

  it("gathers what names no mode into one group at the end", () => {
    const loose = entry({ title: "The eco compendium", kind: "guide" });
    const groups = collectionsOf([loose, ...ladder], profile({ gameModes: ["1v1"] }));
    const last = groups[groups.length - 1];
    expect(last.isRemainder).toBe(true);
    expect(last.key).toBe("");
    expect(last.entries.map((e) => e.title)).toEqual(["The eco compendium"]);
  });

  it("keeps the remainder last whichever order is chosen", () => {
    const loose = entry({ title: "AAA compendium", kind: "guide", updatedAt: "2030-01-01" });
    for (const sort of ["forYou", "recent", "alpha"] as const) {
      const groups = collectionsOf([loose, ...ladder], profile(), sort);
      expect(groups[groups.length - 1].isRemainder).toBe(true);
    }
  });

  it("raises what is on the maps this player has been playing", () => {
    const [group] = collectionsOf(ladder, profile({ maps: ["Open Palms"] }));
    expect(group.entries[0].title).toBe("Open Palms");
  });

  it("leaves a series in its own order when nothing about it is more relevant", () => {
    // The sort is stable and the parts of a series all score alike, so they
    // never overtake each other and episode four stays behind episode two.
    const series = [1, 2, 3].map((part) =>
      entry({ title: `Road to Grandmaster, episode ${part}`, gameModes: ["1v1"] }),
    );
    const [group] = collectionsOf(series, profile({ maps: ["Open Palms"] }));
    expect(group.entries.map((e) => e.title)).toEqual([
      "Road to Grandmaster, episode 1",
      "Road to Grandmaster, episode 2",
      "Road to Grandmaster, episode 3",
    ]);
  });

  it("puts the newest shelf and its newest card first under the recency order", () => {
    const old = entry({ title: "Old", gameModes: ["1v1"], updatedAt: "2025-01-01" });
    const older = entry({ title: "Older", gameModes: ["1v1"], updatedAt: "2024-01-01" });
    const fresh = entry({ title: "Fresh", gameModes: ["custom", "4v4"], updatedAt: "2026-06-01" });
    const fresher = entry({ title: "Fresher", gameModes: ["custom", "4v4"], updatedAt: "2026-07-01" });
    const groups = collectionsOf([old, older, fresh, fresher], profile(), "recent");
    expect(groups.map((group) => group.key)).toEqual(["4v4", "1v1"]);
    expect(groups[0].entries.map((e) => e.title)).toEqual(["Fresher", "Fresh"]);
  });

  it("sorts the shelves and their cards by name under A to Z", () => {
    const groups = collectionsOf([...team, ...ladder], profile(), "alpha");
    expect(groups.map((group) => group.key)).toEqual(["1v1", "4v4"]);
    expect(groups[0].entries.map((e) => e.title)).toEqual(["Arcane", "Open Palms", "Twin Rivers"]);
  });

  it("orders equally relevant shelves the same way twice", () => {
    const once = collectionsOf([...team, ...ladder], profile());
    const twice = collectionsOf([...team, ...ladder], profile());
    expect(once.map((g) => g.key)).toEqual(twice.map((g) => g.key));
  });
});
