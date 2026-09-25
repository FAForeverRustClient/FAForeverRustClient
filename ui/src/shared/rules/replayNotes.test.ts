import { describe, expect, it } from "vitest";
import { normalizeReplayNotes, noteForReplay, parseTagInput, replayNoteMatches } from "./replayNotes";

describe("replay notes", () => {
  it("tidies tags, keeps each once and lets the last note for a replay win", () => {
    expect(normalizeReplayNotes([
      { replayId: 9, comment: " first ", tags: ["old"] },
      { replayId: 12, comment: "", tags: [" Lots  finals ", "LOTS FINALS", " "] },
      { replayId: 9, comment: "  Comeback  ", tags: [] },
      { replayId: 30, comment: " ", tags: [] },
      { replayId: 0, comment: "no game", tags: [] },
    ])).toEqual([
      { replayId: 9, comment: "Comeback", tags: [] },
      { replayId: 12, comment: "", tags: ["Lots finals"] },
    ]);
  });

  it("reads tags typed as one line", () => {
    expect(parseTagInput(" Lots finals, casts,, ")).toEqual(["Lots finals", "casts"]);
  });

  it("finds a replay by any words of its comment or tags", () => {
    const note = { replayId: 5, comment: "Great comeback on Setons", tags: ["Lots finals"] };
    expect(replayNoteMatches(note, "lots setons")).toBe(true);
    expect(replayNoteMatches(note, "lots dual")).toBe(false);
    expect(replayNoteMatches(null, "lots")).toBe(false);
    expect(replayNoteMatches(null, " ")).toBe(true);
  });

  it("has nothing to say about a replay without a game id", () => {
    expect(noteForReplay([{ replayId: 5, comment: "x", tags: [] }], null)).toBeNull();
    expect(noteForReplay([{ replayId: 5, comment: "x", tags: [] }], 5)?.comment).toBe("x");
  });
});
