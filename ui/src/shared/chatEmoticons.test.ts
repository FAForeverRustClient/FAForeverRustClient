import { expect, it } from "vitest";
import { QUICK_REACTIONS, reactionGlyph, reactionFaction } from "./chatEmoticons";

it("renders Java's wire aliases and preserves unknown or older Unicode reactions", () => {
  expect(reactionGlyph(":+1:")).toBe("👍");
  expect(reactionGlyph(":thumbsup:")).toBe("👍");
  expect(reactionGlyph(":thinking:")).toBe("🤔");
  expect(reactionGlyph("custom")).toBe("custom");
  expect(reactionGlyph("🔥")).toBe("🔥");
  expect(reactionFaction(":uef:")).toBe(1);
});

it("offers only recognized Java-compatible reaction codes", () => {
  for (const value of QUICK_REACTIONS) expect(reactionFaction(value) !== undefined || reactionGlyph(value) !== value).toBe(true);
});
