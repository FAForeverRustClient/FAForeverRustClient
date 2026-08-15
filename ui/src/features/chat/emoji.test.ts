import { describe, expect, it } from "vitest";

import {
  ALL_EMOJI,
  EMOJI_COLUMNS,
  EMOJI_GROUPS,
  groupOffsets,
  searchEmoji,
  stepSelection,
} from "./emoji";

describe("the emoji set", () => {
  it("has no duplicate characters across groups", () => {
    // A duplicate would render twice in the "all" view and make the picker
    // look broken for no visible reason.
    const chars = ALL_EMOJI.map((e) => e.char);
    expect(new Set(chars).size).toBe(chars.length);
  });

  it("gives every entry a name to search and announce", () => {
    expect(ALL_EMOJI.every((e) => e.name.trim() !== "")).toBe(true);
  });

  it("keeps every group non-empty", () => {
    expect(EMOJI_GROUPS.every((group) => group.emoji.length > 0)).toBe(true);
  });
});

describe("searching", () => {
  it("shows everything before anything is typed", () => {
    expect(searchEmoji("")).toHaveLength(ALL_EMOJI.length);
    expect(searchEmoji("   ")).toHaveLength(ALL_EMOJI.length);
  });

  it("finds an emoji by its name", () => {
    expect(searchEmoji("thumbs up").map((e) => e.char)).toContain("👍");
  });

  it("finds one by a keyword the name never mentions", () => {
    // The whole reason keywords exist: nobody types "face with tears of joy".
    expect(searchEmoji("lol").map((e) => e.char)).toContain("😂");
    expect(searchEmoji("gg").map((e) => e.char)).toContain("🤝");
    expect(searchEmoji("nuke").map((e) => e.char)).toContain("💥");
  });

  it("ignores case and surrounding space", () => {
    expect(searchEmoji("  ROCKET ").map((e) => e.char)).toContain("🚀");
  });

  it("ranks a prefix match above a mere substring", () => {
    // "ok" is a keyword of thumbs up, and merely sits inside "look" on eyes.
    const results = searchEmoji("ok");
    const thumbsUp = results.findIndex((e) => e.char === "👍");
    const eyes = results.findIndex((e) => e.char === "👀");
    expect(thumbsUp).toBeGreaterThanOrEqual(0);
    expect(eyes).toBeGreaterThanOrEqual(0);
    expect(thumbsUp).toBeLessThan(eyes);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchEmoji("zzzzzz-not-an-emoji")).toEqual([]);
  });

  it("never matches on the character itself", () => {
    // Searching by pasting an emoji is not a feature, and allowing it would
    // make the query box behave differently for one kind of input.
    expect(searchEmoji("👍")).toEqual([]);
  });
});

describe("keyboard selection", () => {
  it("steps by one horizontally and by a row vertically", () => {
    expect(stepSelection(10, "ArrowRight", 50)).toBe(11);
    expect(stepSelection(10, "ArrowLeft", 50)).toBe(9);
    expect(stepSelection(10, "ArrowDown", 50)).toBe(10 + EMOJI_COLUMNS);
    expect(stepSelection(10, "ArrowUp", 50)).toBe(10 - EMOJI_COLUMNS);
  });

  it("clamps at both ends instead of wrapping or escaping", () => {
    expect(stepSelection(0, "ArrowLeft", 50)).toBe(0);
    expect(stepSelection(2, "ArrowUp", 50)).toBe(0);
    expect(stepSelection(49, "ArrowRight", 50)).toBe(49);
    expect(stepSelection(45, "ArrowDown", 50)).toBe(49);
  });

  it("pulls a stale selection back into a list that just shrank", () => {
    // Typing narrows the results under the current selection; without this the
    // picker would index past the end of the new list.
    expect(stepSelection(40, "Unknown", 5)).toBe(4);
  });

  it("stays at zero when there is nothing to select", () => {
    expect(stepSelection(3, "ArrowRight", 0)).toBe(0);
    expect(stepSelection(0, "ArrowDown", 0)).toBe(0);
  });
});

describe("group offsets", () => {
  it("gives each group its start in the flat list", () => {
    const offsets = groupOffsets();
    expect(offsets[0]).toBe(0);
    // Every offset must point at that group's first emoji in the flat list,
    // or the grouped view and the arrow keys disagree about what is selected.
    EMOJI_GROUPS.forEach((group, index) => {
      expect(ALL_EMOJI[offsets[index]]).toBe(group.emoji[0]);
    });
  });
});
