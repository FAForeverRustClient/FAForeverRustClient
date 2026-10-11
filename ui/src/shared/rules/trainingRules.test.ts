import { describe, expect, it } from "vitest";

import type { TrainingProfile, TrainingQuery, TrainingResource } from "../../ipc/bindings";
import { EMPTY_TRAINING_QUERY } from "../trainingQuery";
import {
  coversMap,
  coversMode,
  filterResources,
  leaderboardWord,
  normaliseMap,
  positionOf,
  ratingFor,
  recommendationReason,
  rustTrim,
} from "./trainingRules";

// Spelled by code point, so nothing invisible sits in the source.
const KELVIN = String.fromCharCode(0x212a);
const NEL = String.fromCharCode(0x85);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const BOM = String.fromCharCode(0xfeff);

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

const query = (over: Partial<TrainingQuery>): TrainingQuery => ({
  ...EMPTY_TRAINING_QUERY,
  ...over,
});

describe("mode rules match Rust", () => {
  it("folds ASCII case only, as eq_ignore_ascii_case does", () => {
    const ladder = entry({ gameModes: ["1V1"] });
    expect(coversMode(ladder, "1v1")).toBe(true);
    // The Kelvin sign lowercases to an ASCII k in JavaScript, never in Rust.
    const kelvin = entry({ gameModes: [`${KELVIN}otr`] });
    expect(coversMode(kelvin, "kotr")).toBe(false);
  });

  it("treats custom and global as one mode in both directions", () => {
    expect(coversMode(entry({ gameModes: ["custom"] }), "global")).toBe(true);
    expect(coversMode(entry({ gameModes: ["global"] }), "Custom")).toBe(true);
    expect(coversMode(entry({ gameModes: ["CUSTOM"] }), "custom")).toBe(true);
    expect(leaderboardWord("Custom")).toBe("global");
    // Every other word passes through untouched, case included.
    expect(leaderboardWord("1V1")).toBe("1V1");
  });

  it("looks a mode's rating up by exact key, as BTreeMap::get does", () => {
    const reader = profile({ rating: 1500, ratings: { "1v1": 1100, global: 1700 } });
    expect(ratingFor(reader, entry({ gameModes: ["1v1"] }))).toBe(1100);
    expect(ratingFor(reader, entry({ gameModes: ["custom"] }))).toBe(1700);
    expect(ratingFor(reader, entry({ gameModes: ["1V1"] }))).toBe(1500);
    expect(ratingFor(reader, entry({ gameModes: ["constructor"] }))).toBe(1500);
  });

  it("filters a mode through the same rule", () => {
    const catalogue = [
      entry({ id: "lobby", gameModes: ["custom"] }),
      entry({ id: "ladder", gameModes: ["1v1"] }),
    ];
    const found = filterResources(catalogue, query({ gameMode: " Global " }), profile());
    expect(found.map((resource) => resource.id)).toEqual(["lobby"]);
  });
});

describe("map and text rules match Rust", () => {
  it("drops non-ASCII before folding", () => {
    // An official map's folder folds to its name, as `OFFICIAL_MAPS` says.
    expect(normaliseMap("SCMP_009")).toBe("setonsclutch");
    expect(normaliseMap("scmp_tut_1")).toBe("tut1");
    expect(normaliseMap("Seton's Clutch")).toBe("setonsclutch");
    expect(normaliseMap(`${KELVIN}ing`)).toBe("ing");
  });

  it("matches an official folder against the map's name", () => {
    expect(coversMap(entry({ maps: ["Seton's Clutch"] }), "scmp_009")).toBe(true);
  });

  it("trims what Rust's trim trims", () => {
    expect(rustTrim(`${NEL}setons${IDEOGRAPHIC_SPACE}`)).toBe("setons");
    expect(rustTrim(`${BOM}setons`)).toBe(`${BOM}setons`);
  });
});

describe("positionOf", () => {
  it("finds the newest of the player's maps an entry claims", () => {
    expect(positionOf(["Arcane", "SCMP_009"], ["scmp 009"], "map")).toBe(1);
    expect(positionOf(["Arcane"], [], "map")).toBe(-1);
  });

  it("compares modes exactly, without the custom to global mapping", () => {
    expect(positionOf(["custom"], ["global"], "exact")).toBe(-1);
    expect(positionOf(["2v2", "1v1"], ["1V1"], "exact")).toBe(1);
  });
});

describe("recommendationReason", () => {
  it("names the rating when a stated band covers it, since score weighs that highest", () => {
    const guide = entry({ ratingMin: 1000, ratingMax: 1400, maps: ["Arcane"], gameModes: ["1v1"] });
    const reader = profile({ rating: 1800, ratings: { "1v1": 1200 }, maps: ["Arcane"], gameModes: ["1v1"] });
    expect(recommendationReason(guide, reader)).toEqual({ type: "rating", rating: 1200, mode: "1v1" });
  });

  it("does not offer an open band as a reason", () => {
    const guide = entry({ maps: ["Arcane"] });
    const reader = profile({ rating: 1200, maps: ["Arcane"] });
    expect(recommendationReason(guide, reader)).toEqual({ type: "map", map: "Arcane" });
  });

  it("does not name a rating the band excludes", () => {
    const guide = entry({ ratingMin: 1600, gameModes: ["2v2"] });
    const reader = profile({ rating: 1000, gameModes: ["2v2"] });
    expect(recommendationReason(guide, reader)).toEqual({ type: "mode", mode: "2v2" });
  });

  it("matches maps through the normalisation, showing the catalogue's spelling", () => {
    const guide = entry({ maps: ["Seton's Clutch"] });
    const reader = profile({ maps: ["setons_clutch"] });
    expect(recommendationReason(guide, reader)).toEqual({ type: "map", map: "Seton's Clutch" });
    // A folder id out of a replay header is never what the card says.
    const fromReplay = profile({ maps: ["SCMP_009"] });
    expect(recommendationReason(guide, fromReplay)).toEqual({ type: "map", map: "Seton's Clutch" });
  });

  it("lets a recent mode outweigh a stale map, by the weights score uses", () => {
    // Map at place six: 30 - 20 = 10. Mode at place one: 18.
    const guide = entry({ maps: ["Arcane"], gameModes: ["1v1"] });
    const reader = profile({
      maps: ["Loki", "Theta", "Twin", "Dual", "Wonder", "Arcane"],
      gameModes: ["1v1"],
    });
    expect(recommendationReason(guide, reader)).toEqual({ type: "mode", mode: "1v1" });
  });

  it("is null when nothing overlaps", () => {
    expect(recommendationReason(entry({ maps: ["Arcane"] }), profile({ maps: ["Gap"] }))).toBeNull();
  });
});
