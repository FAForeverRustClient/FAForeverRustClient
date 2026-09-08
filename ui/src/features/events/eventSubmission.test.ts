import { describe, expect, it } from "vitest";
import {
  draftId,
  EMPTY_DRAFT,
  entryFromDraft,
  submissionBlock,
  submissionIssueUrl,
  submissionProblem,
  submissionTitle,
  type EventDraft,
} from "./eventSubmission";

const NEW_ISSUE = "https://github.com/FAForeverRustClient/events/issues/new";

function draft(over: Partial<EventDraft> = {}): EventDraft {
  return {
    ...EMPTY_DRAFT,
    title: "Community Game Night 43",
    day: "2026-10-04",
    time: "18:00",
    endTime: "22:00",
    category: "cgn",
    origin: "community",
    host: "Setons Clutch",
    summary: "Setons, all welcome.",
    ...over,
  };
}

/** The UTC timestamp a local time maps to, wherever these tests are run. */
function utc(day: string, time: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return `${new Date(y, m - 1, d, h, min).toISOString().slice(0, 17)}00Z`;
}

describe("what a submission must state", () => {
  it("accepts a filled form", () => {
    expect(submissionProblem(draft())).toBeNull();
  });

  it("insists on a title and a date", () => {
    expect(submissionProblem(draft({ title: "  " }))).toBe("events.submit.problem.noTitle");
    expect(submissionProblem(draft({ day: "" }))).toBe("events.submit.problem.noDate");
    expect(submissionProblem(draft({ day: "04.10.2026" }))).toBe("events.submit.problem.noDate");
  });

  it("refuses an end before the start rather than guessing", () => {
    // Past midnight and a typo look identical from here, and only the person
    // filling the form knows which it is.
    expect(submissionProblem(draft({ time: "22:00", endTime: "02:00" }))).toBe(
      "events.submit.problem.badEnd",
    );
    expect(submissionProblem(draft({ time: "18:00", endTime: "18:00" }))).toBe(
      "events.submit.problem.badEnd",
    );
  });

  it("needs no time at all, which makes it a whole day", () => {
    expect(submissionProblem(draft({ time: "", endTime: "" }))).toBeNull();
    // And an end time with no start is simply ignored.
    expect(submissionProblem(draft({ time: "", endTime: "22:00" }))).toBeNull();
  });

  it("refuses a link that is not plain https", () => {
    expect(submissionProblem(draft({ linkUrl: "discord.gg/example" }))).toBe(
      "events.submit.problem.badUrl",
    );
    expect(submissionProblem(draft({ linkUrl: "http://example.invalid" }))).toBe(
      "events.submit.problem.badUrl",
    );
    expect(submissionProblem(draft({ linkUrl: "https://discord.gg/example" }))).toBeNull();
  });
});

describe("the entry a draft describes", () => {
  it("converts the local time the player typed into UTC", () => {
    const entry = entryFromDraft(draft());
    expect(entry.startsAt).toBe(utc("2026-10-04", "18:00"));
    expect(entry.endsAt).toBe(utc("2026-10-04", "22:00"));
    expect(entry.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(entry.allDay).toBeUndefined();
  });

  it("keeps a whole-day entry as a bare date, never converted", () => {
    // The distinction the catalogue turns on: a date is the same date
    // everywhere, and running it through a zone is how it becomes the 3rd.
    const entry = entryFromDraft(draft({ time: "", endTime: "" }));
    expect(entry.startsAt).toBe("2026-10-04");
    expect(entry.allDay).toBe(true);
    expect(entry.endsAt).toBeUndefined();
  });

  it("states only what was filled in", () => {
    const entry = entryFromDraft(draft({ host: "", summary: "", endTime: "" }));
    expect(entry.host).toBeUndefined();
    expect(entry.summary).toBeUndefined();
    expect(entry.endsAt).toBeUndefined();
    expect(Object.keys(entry).sort()).toEqual(["category", "id", "origin", "startsAt", "title"]);
  });

  it("spells each recurrence the way the catalogue reads it", () => {
    expect(entryFromDraft(draft({ recurrence: "none" })).recurrence).toBeUndefined();
    expect(entryFromDraft(draft({ recurrence: "weekly" })).recurrence).toEqual({
      weekly: { interval: 1 },
    });
    expect(entryFromDraft(draft({ recurrence: "fortnightly" })).recurrence).toEqual({
      weekly: { interval: 2 },
    });
    expect(entryFromDraft(draft({ recurrence: "monthly" })).recurrence).toBe("monthly");
  });

  it("labels an unlabelled link rather than drawing a bare button", () => {
    const entry = entryFromDraft(draft({ linkUrl: "https://discord.gg/example" }));
    expect(entry.links).toEqual([{ label: "Open", url: "https://discord.gg/example" }]);
  });

  it("collapses and caps a long summary", () => {
    const entry = entryFromDraft(draft({ summary: `a\n\nb ${"x".repeat(400)}` }));
    expect(entry.summary).toHaveLength(280);
    expect(entry.summary?.startsWith("a b ")).toBe(true);
  });

  it("derives an id that is stable and survives a URL", () => {
    expect(draftId(draft())).toBe("community-game-night-43-2026-10-04");
    expect(draftId(draft({ title: "CGN #43: Setons!" }))).toBe("cgn-43-setons-2026-10-04");
    // A title with nothing usable still leaves something addressable.
    expect(draftId(draft({ title: "!!!" }))).toBe("2026-10-04");
  });
});

describe("the issue it opens", () => {
  it("carries the entry in a json block the bot can read", () => {
    const url = submissionIssueUrl(NEW_ISSUE, draft());
    expect(url).not.toBeNull();
    const body = new URL(url!).searchParams.get("body") ?? "";
    const block = /```json\n([\s\S]*?)\n```/.exec(body);
    expect(block).not.toBeNull();
    expect(JSON.parse(block![1])).toEqual(entryFromDraft(draft()));
    expect(new URL(url!).searchParams.get("title")).toBe(submissionTitle(draft()));
    expect(new URL(url!).searchParams.get("labels")).toBe("event");
  });

  it("says the times are UTC, because the block cannot", () => {
    const body = new URL(submissionIssueUrl(NEW_ISSUE, draft())!).searchParams.get("body") ?? "";
    expect(body).toContain("Times are UTC");
    expect(body).toContain("2026-10-04 18:00 to 22:00");
  });

  it("trims the template chooser off the catalogue's own address", () => {
    // What the published document actually carries, so that the button works
    // without the document having to know about this feature.
    const chooser = "https://github.com/FAForeverRustClient/events/issues/new/choose";
    expect(submissionIssueUrl(chooser, draft())).toContain("/issues/new?");
  });

  it("refuses an address that is not a GitHub new-issue page", () => {
    // The address comes out of a remote document, so its shape is checked
    // before the client builds a link out of it.
    expect(submissionIssueUrl("https://example.invalid/new", draft())).toBeNull();
    expect(submissionIssueUrl("http://github.com/a/b/issues/new", draft())).toBeNull();
    expect(submissionIssueUrl("", draft())).toBeNull();
  });

  it("puts the block on its own lines, so the fence is not swallowed", () => {
    const block = submissionBlock(draft());
    expect(block.startsWith("```json\n")).toBe(true);
    expect(block.endsWith("\n```")).toBe(true);
  });
});
