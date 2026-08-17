// `rejectionOf` is a hand-written twin of `TourneyDraft::rejection`, and it is
// what stops an organiser filling in a long form only to be told the name was
// missing. It has no generated fixture holding it to the Rust version, so it
// gets the same cases.

import { describe, expect, it } from "vitest";
import { draftOf, rejectionOf } from "./TournamentForm";
import { tourney } from "./fixtures";
import type { TourneyDraft } from "../../ipc/bindings";

const draft = (over: Partial<TourneyDraft> = {}): TourneyDraft => ({
  ...draftOf(tourney()),
  name: "Weekend Cup",
  teamSize: 2,
  ...over,
});

describe("rejectionOf", () => {
  it("accepts an ordinary draft", () => {
    expect(rejectionOf(draft())).toBeNull();
  });

  it("wants a name that is more than whitespace", () => {
    expect(rejectionOf(draft({ name: "   " }))).toBe("nameRequired");
  });

  it("keeps the team size inside what the server takes", () => {
    expect(rejectionOf(draft({ teamSize: 0 }))).toBe("teamSizeOutOfRange");
    expect(rejectionOf(draft({ teamSize: 7 }))).toBe("teamSizeOutOfRange");
    expect(rejectionOf(draft({ teamSize: 6 }))).toBeNull();
  });

  it("refuses a rating range that excludes everyone", () => {
    const gated = draft({ rating: { min: 2000, max: 1500, maxTeam: null, cap: null } });
    expect(rejectionOf(gated)).toBe("ratingRangeInverted");
  });

  it("refuses a rating gate on an unrated tournament", () => {
    // An unrated event never fetches a rating, so a gate could only ever refuse
    // every signup, and it would do it with a confusing message.
    const unrated = draft({
      ratingKind: "none",
      rating: { min: 1500, max: null, maxTeam: null, cap: null },
    });
    expect(rejectionOf(unrated)).toBe("ratingGateWithoutRating");
    expect(rejectionOf(draft({ ratingKind: "none" }))).toBeNull();
  });

  it("refuses a signup window that closes before it opens", () => {
    const inverted = draft({ signupOpensAt: 1_787_400_000, signupClosesAt: 1_787_300_000 });
    expect(rejectionOf(inverted)).toBe("signupWindowInverted");
  });

  it("takes a window with only one end set", () => {
    expect(rejectionOf(draft({ signupClosesAt: 1_787_300_000 }))).toBeNull();
    expect(rejectionOf(draft({ signupOpensAt: 1_787_300_000 }))).toBeNull();
  });
});

describe("draftOf", () => {
  it("carries the fields an edit may still change", () => {
    const event = tourney({
      name: "Autumn Invitational",
      description: "Four invited players.",
      teamSize: 3,
      playerReporting: false,
      eventDate: 1_787_421_600,
    });
    const from = draftOf(event);
    expect(from.name).toBe("Autumn Invitational");
    expect(from.description).toBe("Four invited players.");
    expect(from.playerReporting).toBe(false);
    expect(from.eventDate).toBe(1_787_421_600);
    // Format fields come along so the form can show them, even though editing
    // never sends them.
    expect(from.teamSize).toBe(3);
  });
});
