import { describe, expect, it } from "vitest";
import {
  allReplayTags,
  gameReplayNotes,
  hasAnyTag,
  noteForReplay,
  parseTagInput,
  replayIdsTagged,
  replayNoteMatches,
} from "./replayNotes";

describe("replay notes", () => {
  it("reuses the note index and rebuilds it for a replaced immutable array", () => {
    let reads = 0;
    const original = { get replayId() { reads += 1; return 5; }, path: null, comment: "old", tags: [] };
    const notes = [original];
    expect(noteForReplay(notes, 5)).toBe(original);
    const indexedReads = reads;
    for (let index = 0; index < 100; index += 1) expect(noteForReplay(notes, index + 1)).toBe(index === 4 ? original : null);
    expect(reads).toBe(indexedReads);
    expect(noteForReplay([{ ...original, comment: "new" }], 5)?.comment).toBe("new");
    expect(noteForReplay(notes, 5)?.comment).toBe("old");
  });

  it("keeps first-match semantics and gives a game ID precedence over its file path", () => {
    const game = { replayId: 5, path: null, comment: "game", tags: [] };
    const file = { replayId: 0, path: "archive/5.fafreplay", comment: "file", tags: [] };
    const notes = [game, { ...game, comment: "duplicate" }, file];
    expect(noteForReplay(notes, 5, file.path)).toBe(game);
    expect(noteForReplay(notes, 0, file.path)).toBe(file);
    expect(noteForReplay(notes, null, "archive/./5.fafreplay")).toBe(file);
  });
  it("reads tags typed as one line", () => {
    expect(parseTagInput(" Lots finals, casts,, ")).toEqual(["Lots finals", "casts"]);
  });

  it("deduplicates tags after whitespace and length normalization, just as saving does", () => {
    const prefix = "x".repeat(32);
    const input = ` Lots  finals, LOTS FINALS, casts, ${prefix}a, ${prefix}b`;
    const parsed = parseTagInput(input);
    expect(parsed).toEqual(["Lots finals", "casts", prefix]);
  });

  it("keeps excess different tags visible to validation instead of silently dropping them", () => {
    const tags = Array.from({ length: 11 }, (_, index) => `tag${index}`);
    expect(parseTagInput(tags.join(","))).toEqual(tags);
  });

  it("finds a replay by any words of its comment or tags", () => {
    const note = { replayId: 5, comment: "Great comeback on Setons", tags: ["Lots finals"] };
    expect(replayNoteMatches(note, "lots setons")).toBe(true);
    expect(replayNoteMatches(note, "lots dual")).toBe(false);
    expect(replayNoteMatches(null, "lots")).toBe(false);
    expect(replayNoteMatches(null, " ")).toBe(true);
  });

  it("finds a game's note by its id and a file's by its path", () => {
    const notes = [
      { replayId: 5, path: null, comment: "x", tags: [] },
      { replayId: 0, path: "c:/replays/skirmish.fafreplay", comment: "file", tags: [] },
    ];
    expect(noteForReplay(notes, 5)?.comment).toBe("x");
    expect(noteForReplay(notes, 5, "D:/elsewhere/5.fafreplay")?.comment).toBe("x");
    expect(noteForReplay(notes, 0, "C:\\Replays\\Skirmish.fafreplay")?.comment).toBe("file");
    expect(noteForReplay(notes, null, "C:/Replays/old/../Skirmish.fafreplay")?.comment).toBe("file");
    // Neither a game nor a file: nothing a note could be on.
    expect(noteForReplay(notes, null)).toBeNull();
    expect(noteForReplay(notes, 0, "")).toBeNull();
    expect(noteForReplay(notes, 0, "C:/Replays/Other.fafreplay")).toBeNull();
  });
});

describe("filtering by tag", () => {
  const notes = [
    { replayId: 3, comment: "", tags: ["Lots finals", "casts"] },
    { replayId: 7, comment: "x", tags: ["lots finals"] },
    { replayId: 9, comment: "only a comment", tags: [] },
  ];

  it("offers every tag once", () => {
    expect(allReplayTags(notes)).toEqual(["casts", "Lots finals"]);
  });

  it("finds the games with any chosen tag, whatever its case", () => {
    expect(replayIdsTagged(notes, ["LOTS FINALS"])).toEqual(["3", "7"]);
    expect(replayIdsTagged(notes, [])).toEqual([]);
    expect(hasAnyTag(null, ["casts"])).toBe(false);
    expect(hasAnyTag(null, [])).toBe(true);
  });

  it("asks the vault for no game on behalf of a file without one", () => {
    const withFile = [...notes, { replayId: 0, path: "c:/replays/skirmish.fafreplay", comment: "", tags: ["ai", "casts"] }];
    expect(replayIdsTagged(withFile, ["ai"])).toEqual([]);
    expect(replayIdsTagged(withFile, ["casts"])).toEqual(["3"]);
    expect(allReplayTags(gameReplayNotes(withFile))).toEqual(["casts", "Lots finals"]);
  });
});
