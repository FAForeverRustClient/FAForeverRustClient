import { describe, expect, it } from "vitest";
import { partyDraftKey, readDraft, writeDraft } from "./composerDrafts";

describe("composer drafts", () => {
  it("keeps one unsent line per conversation", () => {
    writeDraft("#aeolus", "half an answer");
    writeDraft("Somebody", "a private one");
    expect(readDraft("#aeolus")).toBe("half an answer");
    expect(readDraft("Somebody")).toBe("a private one");
    expect(readDraft("#elsewhere")).toBe("");
  });

  it("forgets a line once it is emptied, which is what sending does", () => {
    writeDraft("#sent", "on its way");
    writeDraft("#sent", "");
    expect(readDraft("#sent")).toBe("");
  });

  it("keeps the party panel apart from the same room in the Chat tab", () => {
    const room = "#Owner'sParty";
    writeDraft(room, "typed in the Chat tab");
    writeDraft(partyDraftKey(room), "typed in the matchmaker");
    expect(readDraft(room)).toBe("typed in the Chat tab");
    expect(readDraft(partyDraftKey(room))).toBe("typed in the matchmaker");
    expect(partyDraftKey(room)).not.toBe(room);
  });
});
