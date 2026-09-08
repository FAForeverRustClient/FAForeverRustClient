import { describe, expect, it } from "vitest";
import { categoryOf, entryOf, mergeCalendar, recurrenceOf, summaryOf } from "./events-bot.mjs";

/** The Dojo, as a source would be configured. */
const dojo = {
  guildId: "1230169748889669682",
  host: "FAF Dojo",
  origin: "community",
  category: "meetup",
  invite: "https://discord.gg/example",
  rules: [{ match: "tournament", category: "tournament" }],
};

/** One Discord scheduled event, scheduled and weekly. */
function scheduled(over = {}) {
  return {
    id: "1400000000000000000",
    name: "Dojo 1v1 Night",
    description: "Casual 1v1s, all ratings welcome.",
    scheduled_start_time: "2026-09-12T18:00:00+00:00",
    scheduled_end_time: "2026-09-12T22:00:00+00:00",
    status: 1,
    entity_type: 2,
    entity_metadata: null,
    recurrence_rule: { frequency: 2, interval: 1, by_weekday: [4] },
    ...over,
  };
}

describe("mapping a Discord scheduled event", () => {
  it("carries the name, the times and the source's labels", () => {
    const entry = entryOf(scheduled(), dojo);
    expect(entry).toMatchObject({
      id: `discord-${dojo.guildId}-1400000000000000000`,
      title: "Dojo 1v1 Night",
      summary: "Casual 1v1s, all ratings welcome.",
      category: "meetup",
      origin: "community",
      host: "FAF Dojo",
      startsAt: "2026-09-12T18:00:00+00:00",
      endsAt: "2026-09-12T22:00:00+00:00",
      recurrence: { weekly: { interval: 1 } },
    });
  });

  it("links the event and the way into the server", () => {
    const entry = entryOf(scheduled(), dojo);
    expect(entry.links.map((link) => link.url)).toEqual([
      `https://discord.com/events/${dojo.guildId}/1400000000000000000`,
      "https://discord.gg/example",
    ]);
  });

  it("adds an external event's location only when it is an address", () => {
    const streamed = entryOf(
      scheduled({ entity_type: 3, entity_metadata: { location: "https://twitch.tv/faflive" } }),
      dojo,
    );
    expect(streamed.links.at(-1)).toEqual({ label: "Where", url: "https://twitch.tv/faflive" });
    // "The Dojo, room 2" is not something to put behind a button.
    const inPerson = entryOf(
      scheduled({ entity_type: 3, entity_metadata: { location: "Setons, slot 4" } }),
      dojo,
    );
    expect(inPerson.links).toHaveLength(2);
  });

  it("skips an event that is over or was called off", () => {
    expect(entryOf(scheduled({ status: 3 }), dojo)).toBeNull();
    expect(entryOf(scheduled({ status: 4 }), dojo)).toBeNull();
    expect(entryOf(scheduled({ status: 2 }), dojo)).not.toBeNull();
  });

  it("skips an event the client would drop anyway", () => {
    expect(entryOf(scheduled({ name: "  " }), dojo)).toBeNull();
    expect(entryOf(scheduled({ scheduled_start_time: null }), dojo)).toBeNull();
  });

  it("leaves out the end and the rule when Discord did not give one", () => {
    const entry = entryOf(
      scheduled({ scheduled_end_time: null, recurrence_rule: null }),
      dojo,
    );
    expect(entry.endsAt).toBeUndefined();
    expect(entry.recurrence).toBeUndefined();
  });
});

describe("reading a recurrence rule", () => {
  it("maps weekly and fortnightly", () => {
    expect(recurrenceOf({ frequency: 2, interval: 1 })).toEqual({ weekly: { interval: 1 } });
    expect(recurrenceOf({ frequency: 2, interval: 2 })).toEqual({ weekly: { interval: 2 } });
  });

  it("maps a monthly rule, and refuses every-other-month", () => {
    // The catalogue's monthly rule is "the same day, every month", so an
    // interval of two is not one of them.
    expect(recurrenceOf({ frequency: 1, interval: 1 })).toBe("monthly");
    expect(recurrenceOf({ frequency: 1, interval: 2 })).toBeNull();
  });

  it("refuses a rule that names more than one weekday", () => {
    // The catalogue repeats on the weekday of the first occurrence, so a
    // Tuesday-and-Thursday event would silently lose one of them. Published as
    // its next occurrence instead, which is visibly one entry rather than
    // invisibly the wrong two.
    expect(recurrenceOf({ frequency: 2, interval: 1, by_weekday: [1, 3] })).toBeNull();
    expect(recurrenceOf({ frequency: 2, interval: 1, by_weekday: [1] })).toEqual({
      weekly: { interval: 1 },
    });
  });

  it("has nothing to say about daily or yearly", () => {
    expect(recurrenceOf({ frequency: 3, interval: 1 })).toBeNull();
    expect(recurrenceOf({ frequency: 0, interval: 1 })).toBeNull();
    expect(recurrenceOf(null)).toBeNull();
  });

  it("treats a missing or nonsense interval as one", () => {
    expect(recurrenceOf({ frequency: 2 })).toEqual({ weekly: { interval: 1 } });
    expect(recurrenceOf({ frequency: 2, interval: 0 })).toEqual({ weekly: { interval: 1 } });
  });
});

describe("choosing a category", () => {
  it("uses the first rule whose text is in the name", () => {
    expect(categoryOf("Dojo Winter Tournament", dojo)).toBe("tournament");
    expect(categoryOf("dojo winter TOURNAMENT", dojo)).toBe("tournament");
  });

  it("falls back to the source's own default", () => {
    expect(categoryOf("Dojo 1v1 Night", dojo)).toBe("meetup");
    expect(categoryOf("anything", { guildId: "1" })).toBe("other");
  });
});

describe("summarising a description", () => {
  it("collapses the whitespace Discord allows", () => {
    expect(summaryOf("Two lines\n\nand   spaces ")).toBe("Two lines and spaces");
    expect(summaryOf(null)).toBe("");
  });

  it("cuts a long one rather than putting an essay on a chip", () => {
    const summary = summaryOf("x".repeat(400));
    expect(summary).toHaveLength(280);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("merging into the published document", () => {
  const hand = { id: "ladder-pool-rotation", title: "Ladder map pool rotation", startsAt: "2026-10-01" };
  const stale = { id: "discord-1-9", title: "Last week's night", startsAt: "2026-09-05T18:00:00+00:00" };

  it("keeps every hand-written entry and replaces its own", () => {
    const merged = mergeCalendar({ events: [hand, stale] }, [
      { id: "discord-1-10", title: "This week's night", startsAt: "2026-09-12T18:00:00+00:00" },
    ]);
    expect(merged.events.map((event) => event.id)).toEqual([
      "discord-1-10",
      "ladder-pool-rotation",
    ]);
  });

  it("drops its own entries when a server has none left", () => {
    // An event deleted on Discord has to disappear here too, which is the
    // whole reason the bot owns its ids rather than appending.
    expect(mergeCalendar({ events: [hand, stale] }, []).events).toEqual([hand]);
  });

  it("keeps the rest of the document, such as the submission link", () => {
    const merged = mergeCalendar({ submitUrl: "https://example.invalid/new", events: [] }, []);
    expect(merged.submitUrl).toBe("https://example.invalid/new");
  });

  it("orders by start so a diff reads as what moved", () => {
    const merged = mergeCalendar({ events: [] }, [
      { id: "discord-1-b", startsAt: "2026-12-01T00:00:00+00:00" },
      { id: "discord-1-a", startsAt: "2026-01-01T00:00:00+00:00" },
    ]);
    expect(merged.events.map((event) => event.id)).toEqual(["discord-1-a", "discord-1-b"]);
  });
});
