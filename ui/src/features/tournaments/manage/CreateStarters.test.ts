// The create form's two starting points: a copy leaves the source's dates
// behind, and a preset lays its settings over the form and names itself.

import { describe, expect, it } from "vitest";
import { presetDraft, templateDraft } from "./CreateStarters";
import { tourney } from "../fixtures";
import type { TourneyPreset } from "../../../ipc/bindings";

describe("templateDraft", () => {
  it("copies the settings and none of the dates", () => {
    const source = tourney({
      name: "Autumn Cup",
      maxTeams: 16,
      eventDate: 1_790_000_000,
      eventDays: ["2026-09-21", "2026-09-22"],
      signupOpensAt: 1_789_000_000,
      ratingDate: 1_788_000_000,
    });
    const draft = templateDraft(source);
    expect(draft.name).toBe("Autumn Cup");
    expect(draft.maxTeams).toBe(16);
    expect([draft.eventDate, draft.signupOpensAt, draft.ratingDate]).toEqual([null, null, null]);
    expect(draft.eventDays).toEqual([]);
  });
});

describe("presetDraft", () => {
  it("fills the format from the preset and records which it was", () => {
    const apply = tourney({ bracketKind: "swiss", teamSize: 1, maxTeams: 16, pickOpponents: true });
    const preset: TourneyPreset = { id: "lots", name: "LotS", blurb: "", notes: [], allowed: true, apply };
    const draft = presetDraft(templateDraft(tourney({ name: "Mine" })), preset);
    expect(draft.presetId).toBe("lots");
    expect(draft.category).toBe("official");
    expect(draft.bracketKind).toBe("swiss");
    expect(draft.maxTeams).toBe(16);
    expect(draft.picks.on).toBe(true);
    expect(draft.name).toBe("Mine");
  });
});
