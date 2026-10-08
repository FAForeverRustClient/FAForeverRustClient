import { describe, expect, it } from "vitest";
import type { ContributionDraft } from "../../ipc/bindings";
import {
  normaliseRatings,
  parseRating,
  ratingProblem,
  sameDraft,
  splitMaps,
} from "./contributionDraft";

const draft = (changes: Partial<ContributionDraft> = {}): ContributionDraft => ({
  title: "Eco basics",
  summary: "",
  kind: "guide",
  level: null,
  url: "",
  body: "Build mass first.",
  topics: ["economy"],
  gameModes: ["1v1"],
  maps: [],
  factions: [],
  ratingMin: "",
  ratingMax: "",
  ...changes,
});

describe("sameDraft", () => {
  it("treats the state's echo of a draft as the same draft", () => {
    // A different object with the same content is exactly what the backend
    // sends back after the form keeps a draft.
    expect(sameDraft(draft(), draft())).toBe(true);
  });

  it("notices a change in any text field", () => {
    expect(sameDraft(draft(), draft({ body: "Build mass first. Then power." }))).toBe(false);
    expect(sameDraft(draft(), draft({ ratingMax: "1200" }))).toBe(false);
  });

  it("compares the tag lists by content and order", () => {
    expect(sameDraft(draft({ maps: ["Seton's"] }), draft({ maps: ["Seton's"] }))).toBe(true);
    expect(sameDraft(draft(), draft({ topics: ["economy", "micro"] }))).toBe(false);
    expect(sameDraft(draft({ gameModes: ["1v1", "2v2"] }), draft({ gameModes: ["2v2", "1v1"] }))).toBe(false);
  });

  it("tells a reset form from a kept one", () => {
    expect(sameDraft(draft(), draft({ level: "beginner" }))).toBe(false);
    expect(sameDraft(null, draft())).toBe(false);
    expect(sameDraft(null, null)).toBe(true);
  });
});

describe("parseRating", () => {
  it("reads a bound the way people write one", () => {
    expect(parseRating("1200")).toBe(1200);
    expect(parseRating(" 1,200 ")).toBe(1200);
    expect(parseRating("1.200")).toBe(1200);
    expect(parseRating("1 200")).toBe(1200);
    expect(parseRating("1200+")).toBe(1200);
    expect(parseRating("1,200+")).toBe(1200);
  });

  it("treats an empty field as no bound", () => {
    expect(parseRating("")).toBeNull();
    expect(parseRating("   ")).toBeNull();
  });

  it("calls anything else invalid instead of dropping it", () => {
    for (const bad of ["abc", "12a", "-300", "+", "1200++", "~1000"]) {
      expect(parseRating(bad)).toBe("invalid");
    }
  });
});

describe("ratingProblem", () => {
  it("accepts an open or an ordered band", () => {
    expect(ratingProblem(draft())).toBeNull();
    expect(ratingProblem(draft({ ratingMin: "800" }))).toBeNull();
    expect(ratingProblem(draft({ ratingMin: "800", ratingMax: "1,200" }))).toBeNull();
    expect(ratingProblem(draft({ ratingMin: "1000", ratingMax: "1000" }))).toBeNull();
  });

  it("names the bound that does not parse", () => {
    expect(ratingProblem(draft({ ratingMin: "lots" }))).toBe("ratingMinInvalid");
    expect(ratingProblem(draft({ ratingMax: "lots" }))).toBe("ratingMaxInvalid");
  });

  it("refuses a minimum above the maximum", () => {
    expect(ratingProblem(draft({ ratingMin: "1500", ratingMax: "1200" }))).toBe("ratingOrder");
  });
});

describe("normaliseRatings", () => {
  it("writes parsed bounds as bare digits", () => {
    const result = normaliseRatings(draft({ ratingMin: " 1,000 ", ratingMax: "1600+" }));
    expect(result.ratingMin).toBe("1000");
    expect(result.ratingMax).toBe("1600");
  });

  it("returns the same draft when nothing changes", () => {
    const same = draft({ ratingMin: "800" });
    expect(normaliseRatings(same)).toBe(same);
  });

  it("leaves a bound it cannot read as it was", () => {
    expect(normaliseRatings(draft({ ratingMin: "lots" })).ratingMin).toBe("lots");
  });
});

describe("splitMaps", () => {
  it("splits on commas and keeps spaces inside a name", () => {
    expect(splitMaps("Setons Clutch, Dual Gap")).toEqual(["Setons Clutch", "Dual Gap"]);
  });

  it("drops empty entries, so a trailing comma mid-typing is harmless", () => {
    expect(splitMaps("Setons Clutch, ")).toEqual(["Setons Clutch"]);
    expect(splitMaps(" , ,")).toEqual([]);
  });
});
