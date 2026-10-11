// The pending bar's two rules: a website tab opens the client section it
// matches (a draft opens the Draft section, not Teams), and each kind is said
// in the reader's language with the count the service put in its sentence.

import { describe, expect, it } from "vitest";
import { pendingText, sectionForTab } from "./sitePages";
import type { PendingItem } from "../../../ipc/bindings";

const item = (over: Partial<PendingItem>): PendingItem => ({
  tournamentId: "e1",
  tournamentName: "Cup",
  kind: "requests",
  tab: "players",
  text: "",
  count: null,
  ...over,
});

const t = (key: string, values?: Record<string, string | number>) =>
  values === undefined ? key : `${key}${JSON.stringify(values)}`;

describe("sectionForTab", () => {
  it("opens the draft for a draft pick and the named tab otherwise", () => {
    expect(sectionForTab(item({ kind: "draft", tab: "teams" }))).toBe("draft");
    expect(sectionForTab(item({ kind: "veto", tab: "vetoes" }))).toBe("vetoes");
    expect(sectionForTab(item({ kind: "other", tab: "nowhere" }))).toBe("overview");
  });
});

describe("pendingText", () => {
  it("keeps the count and says a map veto step by its kind", () => {
    expect(pendingText(item({ count: 3 }), t as never)).toBe('tournaments.pending.requests{"count":3}');
    expect(pendingText(item({ kind: "veto", text: "Your turn to ban a map" }), t as never)).toBe(
      "tournaments.pending.vetoBan",
    );
  });

  it("falls back to the service's sentence for a kind it does not know", () => {
    expect(pendingText(item({ kind: "new", text: "Something new" }), t as never)).toBe("Something new");
  });
});
