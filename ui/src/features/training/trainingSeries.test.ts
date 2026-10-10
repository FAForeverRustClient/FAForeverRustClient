import { describe, expect, it } from "vitest";

import type { TrainingResource } from "../../ipc/bindings";
import { chapterTitle, foldSeries, partTitle, seriesIndex } from "./trainingSeries";

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

const entry = (over: Partial<TrainingResource>): TrainingResource => ({ ...base, ...over });
const video = (id: string, title: string, list: string) =>
  entry({ id, title, kind: "video", url: `https://www.youtube.com/watch?v=${id.padEnd(11, "x")}&list=${list}` });

describe("seriesIndex", () => {
  it("makes one series of the videos in a playlist, named for what they share", () => {
    const parts = [
      video("intro", "Road to Grandmaster: introduction", "PLgm"),
      video("ep1", "Road to Grandmaster, episode 1", "PLgm"),
      video("ep2", "Road to Grandmaster, episode 2", "PLgm"),
    ];
    const series = seriesIndex(parts).get("ep2");
    expect(series?.title).toBe("Road to Grandmaster");
    expect(series?.head.id).toBe("intro");
    expect(series?.parts).toHaveLength(3);
    expect(series?.unit).toBe("episodes");
  });

  it("never folds build orders, which are each about their own map", () => {
    const orders = [
      entry({ id: "a", kind: "buildOrder", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLbo" }),
      entry({ id: "b", kind: "buildOrder", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb&list=PLbo" }),
    ];
    expect(seriesIndex(orders).size).toBe(0);
  });

  it("makes a series of an index and the parts that point back at it alone", () => {
    const index = entry({ id: "hub", title: "Ladder 1v1: topics", related: ["p1", "p2", "other"] });
    const parts = [
      entry({ id: "p1", title: "Ladder 1v1, part 1: a strong start", related: ["hub"] }),
      entry({ id: "p2", title: "Ladder 1v1, part 2: moving out", related: ["hub"] }),
      // Points at the index and something else: related, not a part.
      entry({ id: "other", title: "Beginner 1v1 guide", related: ["hub", "wiki"] }),
    ];
    const series = seriesIndex([index, ...parts]).get("p1");
    expect(series?.parts.map((part) => part.id)).toEqual(["hub", "p1", "p2"]);
    expect(series?.title).toBe("Ladder 1v1");
    expect(seriesIndex([index, ...parts]).has("other")).toBe(false);
    expect(partTitle(series!, parts[0])).toBe("Part 1: a strong start");
  });

  it("names a series by its index when the titles share no name", () => {
    const index = entry({ id: "hub", title: "The Ultimate Seton's Guide", related: ["b", "n"] });
    const parts = [
      entry({ id: "b", title: "Seton's: the beginner guide", related: ["hub"] }),
      entry({ id: "n", title: "Seton's: the novice guide", related: ["hub"] }),
    ];
    expect(seriesIndex([index, ...parts]).get("n")?.title).toBe("The Ultimate Seton's Guide");
  });
});

describe("foldSeries", () => {
  it("keeps one card per series, where its first shown part stood", () => {
    const parts = [video("a", "Show, episode 1", "PL"), video("b", "Show, episode 2", "PL")];
    const loose = entry({ id: "loose", title: "Something else" });
    const index = seriesIndex(parts);
    expect(foldSeries([parts[0], loose, parts[1]], index).map((e) => e.id)).toEqual(["a", "loose"]);
  });
});

describe("chapterTitle", () => {
  it("drops the part number a label beside it already shows", () => {
    const index = entry({ id: "hub", title: "Ladder 1v1: topics", related: ["p1", "p2"] });
    const parts = [
      entry({ id: "p1", title: "Ladder 1v1, part 1: a strong start", related: ["hub"] }),
      entry({ id: "p2", title: "Ladder 1v1, part 2: moving out", related: ["hub"] }),
    ];
    const series = seriesIndex([index, ...parts]).get("p1")!;
    expect(chapterTitle(series, parts[0])).toBe("A strong start");
    expect(chapterTitle(series, parts[1])).toBe("Moving out");
  });
});
