import { describe, expect, it } from "vitest";
import type { ContributionDraft } from "../../ipc/bindings";
import { sameDraft } from "./contributionDraft";

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
