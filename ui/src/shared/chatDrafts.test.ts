import { beforeEach, describe, expect, it } from "vitest";
import { clearDrafts, draftSession, partyDraftKey, readDraft, tournamentDraftKey, writeDraft } from "./chatDrafts";

beforeEach(clearDrafts);

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

  it("clears inactive conversation, party and tournament drafts together", () => {
    const keys = ["#aeolus", "Somebody", partyDraftKey("party"), tournamentDraftKey("event", "global")];
    for (const key of keys) writeDraft(key, "private draft");
    clearDrafts();
    for (const key of keys) expect(readDraft(key)).toBe("");
  });

  it("rejects a write captured before the session ended", () => {
    const owner = draftSession();
    clearDrafts();
    writeDraft("#aeolus", "old session", owner);
    expect(readDraft("#aeolus")).toBe("");
  });
});
