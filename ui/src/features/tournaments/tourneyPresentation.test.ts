// The list's own rules: which group a tournament is in, how the archive is
// ordered, and how long until something starts.
//
// Presentation, so no conformance twin: nothing in `faf_domain` groups the list
// or counts down to a date. What is worth pinning here is the pair of cases
// that were wrong on screen: an event whose signups have not opened saying
// "Signups open", and an abandoned one sitting in the live list.

import { describe, expect, it } from "vitest";
import { countdownTo, groupOf, groupedEvents, rankedEntrants } from "./tourneyPresentation";
import { player, tourney } from "./fixtures";

describe("groupOf", () => {
  it("puts an unpublished event in the drafts, whatever its status says", () => {
    expect(groupOf(tourney({ published: false, status: "signup" }))).toBe("drafts");
  });

  it("counts an abandoned event as past even while it says signups are open", () => {
    // The service leaves the status alone when an organiser calls an event off,
    // so the status on its own would keep it in the live list forever.
    expect(groupOf(tourney({ status: "signup", abandoned: true }))).toBe("past");
    expect(groupOf(tourney({ status: "running", abandoned: true }))).toBe("past");
  });

  it("splits the live events into upcoming and ongoing", () => {
    expect(groupOf(tourney({ status: "signup" }))).toBe("upcoming");
    expect(groupOf(tourney({ status: "drafted" }))).toBe("ongoing");
    expect(groupOf(tourney({ status: "running" }))).toBe("ongoing");
    expect(groupOf(tourney({ status: "finished" }))).toBe("past");
  });
});

describe("groupedEvents", () => {
  it("keeps the service's order in the live groups and sorts the archive by date", () => {
    const grouped = groupedEvents([
      tourney({ id: "a", status: "signup", eventDate: 300 }),
      tourney({ id: "old", status: "finished", eventDate: 100 }),
      tourney({ id: "b", status: "signup", eventDate: 200 }),
      tourney({ id: "recent", status: "finished", eventDate: 900 }),
    ]);
    expect(grouped.upcoming.map((event) => event.id)).toEqual(["a", "b"]);
    // The interesting end of an archive is the recent end.
    expect(grouped.past.map((event) => event.id)).toEqual(["recent", "old"]);
    expect(grouped.ongoing).toEqual([]);
  });

  it("gives every event exactly one group", () => {
    const events = [
      tourney({ id: "1", status: "signup" }),
      tourney({ id: "2", status: "running" }),
      tourney({ id: "3", status: "finished" }),
      tourney({ id: "4", published: false }),
    ];
    const grouped = groupedEvents(events);
    const total =
      grouped.drafts.length + grouped.upcoming.length + grouped.ongoing.length + grouped.past.length;
    expect(total).toBe(events.length);
  });
});

describe("countdownTo", () => {
  it("counts down in days, hours and minutes", () => {
    expect(countdownTo(1_000_000 + 86_400 * 2 + 3_600 * 3 + 60 * 40, 1_000_000)).toBe(
      "2 d, 3 h, 40 min",
    );
  });

  it("drops the hours only when there is no day either", () => {
    expect(countdownTo(1_000_000 + 60 * 5, 1_000_000)).toBe("5 min");
    expect(countdownTo(1_000_000 + 3_600 * 2, 1_000_000)).toBe("2 h, 0 min");
  });

  it("is null once the moment has passed, which is what makes the badge switch back", () => {
    expect(countdownTo(1_000_000, 1_000_000)).toBeNull();
    expect(countdownTo(999_999, 1_000_000)).toBeNull();
    expect(countdownTo(null, 1_000_000)).toBeNull();
  });
});

describe("rankedEntrants", () => {
  it("ranks by the tournament's own rating, highest first", () => {
    const ranked = rankedEntrants([
      player({ id: "a", rating: 1200 }),
      player({ id: "b", rating: 1900 }),
      player({ id: "c", rating: 1500 }),
    ]);
    expect(ranked.map((entrant) => entrant.id)).toEqual(["b", "c", "a"]);
  });

  it("puts the unrated at the bottom rather than at the top", () => {
    // A null sorted as zero would be a "0" rating; sorted as a missing number
    // by a careless comparator it lands wherever the engine leaves it.
    const ranked = rankedEntrants([
      player({ id: "none", rating: null }),
      player({ id: "rated", rating: 800 }),
      player({ id: "alsoNone", rating: null }),
    ]);
    expect(ranked.map((entrant) => entrant.id)).toEqual(["rated", "none", "alsoNone"]);
  });

  it("leaves the caller's array alone", () => {
    const entrants = [player({ id: "a", rating: 100 }), player({ id: "b", rating: 900 })];
    rankedEntrants(entrants);
    expect(entrants.map((entrant) => entrant.id)).toEqual(["a", "b"]);
  });
});
