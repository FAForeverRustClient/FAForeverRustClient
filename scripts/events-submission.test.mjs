import { describe, expect, it } from "vitest";
import {
  derivedId,
  extractEntry,
  mergeSubmission,
  validateEntry,
} from "./events-submission.mjs";

/** An entry as the client's form composes it. */
function entry(over = {}) {
  return {
    id: "community-game-night-43-2026-10-04",
    title: "Community Game Night 43",
    category: "cgn",
    origin: "community",
    startsAt: "2026-10-04T18:00:00Z",
    endsAt: "2026-10-04T22:00:00Z",
    summary: "Setons, all welcome.",
    host: "Setons Clutch",
    ...over,
  };
}

/** An issue body as the client prefills it. */
function body(value = entry()) {
  return [
    "Submitted from the FAForever client. The block below is the catalogue entry.",
    "",
    "Times are UTC.",
    "",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
  ].join("\n");
}

describe("reading the block out of an issue", () => {
  it("finds the entry the client composed", () => {
    expect(extractEntry(body())).toEqual({ entry: entry(), problems: [] });
  });

  it("says nothing at all when the issue was written by hand", () => {
    // Not an error: a hand-written issue is a fine submission, it just needs a
    // person, and failing here would put a red cross on somebody's first one.
    expect(extractEntry("There is a game night on Saturday, 18:00 CEST.")).toEqual({
      entry: null,
      problems: [],
    });
  });

  it("complains about a block that does not parse", () => {
    const { entry: found, problems } = extractEntry("```json\n{ nope\n```");
    expect(found).toBeNull();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not parse");
  });

  it("refuses a block that is not an object", () => {
    expect(extractEntry("```json\n[1, 2]\n```").problems).toEqual([
      "the json block is not an object",
    ]);
  });

  it("takes the first block, so a comment below cannot smuggle a second", () => {
    const two = `${body()}\n\n\`\`\`json\n${JSON.stringify(entry({ id: "other" }))}\n\`\`\``;
    expect(extractEntry(two).entry.id).toBe(entry().id);
  });
});

describe("checking a submitted entry", () => {
  it("accepts what the form produces", () => {
    expect(validateEntry(entry())).toEqual([]);
  });

  it("insists on a title and a readable start", () => {
    expect(validateEntry(entry({ title: "" }))).toContain("no title");
    expect(validateEntry(entry({ startsAt: "next tuesday" }))).toContain(
      "startsAt is missing, or is not a date or a timestamp",
    );
    expect(validateEntry(entry({ startsAt: undefined }))).toHaveLength(1);
    // A bare date is a whole-day entry and perfectly valid.
    expect(validateEntry(entry({ startsAt: "2026-10-04", endsAt: undefined }))).toEqual([]);
  });

  it("refuses an id in the bot's namespace", () => {
    // Otherwise a submission could overwrite a mirrored Discord event, and the
    // next bot run would silently put it back.
    expect(validateEntry(entry({ id: "discord-1-2" }))[0]).toContain("belong to the Discord bot");
  });

  it("refuses a category or origin the client does not draw", () => {
    expect(validateEntry(entry({ category: "lan" }))[0]).toContain("is not one of");
    expect(validateEntry(entry({ origin: "faf" }))[0]).toContain("is not one of");
  });

  it("refuses a link that is not plain https", () => {
    expect(
      validateEntry(entry({ links: [{ label: "x", url: "javascript:alert(1)" }] }))[0],
    ).toContain("not a plain https address");
    expect(validateEntry(entry({ links: [{ label: "x", url: "https://ok.invalid" }] }))).toEqual(
      [],
    );
    expect(validateEntry(entry({ links: "https://ok.invalid" }))).toContain("links is not a list");
  });

  it("refuses a field the catalogue does not know", () => {
    // An edited block is text in a public issue; a stray key is more likely a
    // misunderstanding than an attack, and either way it is not committed.
    expect(validateEntry(entry({ attendees: 40 }))[0]).toContain("unknown field(s): attendees");
  });
});

describe("merging a submission", () => {
  const existing = {
    id: "ladder-pool-rotation",
    title: "Ladder map pool rotation",
    startsAt: "2026-10-01",
  };

  it("adds the entry and keeps the document in start order", () => {
    const result = mergeSubmission({ submitUrl: "x", events: [existing] }, entry());
    expect(result.added).toBe(true);
    expect(result.id).toBe(entry().id);
    expect(result.calendar.events.map((event) => event.id)).toEqual([
      "ladder-pool-rotation",
      entry().id,
    ]);
    expect(result.calendar.submitUrl).toBe("x");
  });

  it("does nothing the second time the same submission is applied", () => {
    // The workflow can run again when an issue is edited or relabelled.
    const once = mergeSubmission({ events: [] }, entry());
    const twice = mergeSubmission(once.calendar, entry());
    expect(twice.added).toBe(false);
    expect(twice.calendar.events).toHaveLength(1);
  });

  it("recognises the same entry with its keys in another order", () => {
    const reordered = { startsAt: entry().startsAt, title: entry().title };
    const once = mergeSubmission({ events: [] }, { title: entry().title, startsAt: entry().startsAt });
    expect(mergeSubmission(once.calendar, reordered).added).toBe(false);
  });

  it("suffixes an id somebody else already used rather than overwriting it", () => {
    const taken = { ...entry(), title: "Somebody else's night" };
    const result = mergeSubmission({ events: [taken] }, entry());
    expect(result.added).toBe(true);
    expect(result.id).toBe(`${entry().id}-2`);
    expect(result.calendar.events).toHaveLength(2);
    expect(result.calendar.events.find((event) => event.id === entry().id).title).toBe(
      "Somebody else's night",
    );
  });

  it("derives an id for an entry that gave none", () => {
    expect(derivedId({ title: "CGN #43", startsAt: "2026-10-04T18:00:00Z" })).toBe(
      "cgn-43-2026-10-04",
    );
    expect(derivedId({ title: "!!!", startsAt: "2026-10-04" })).toBe("2026-10-04");
    const result = mergeSubmission({ events: [] }, { title: "Game night", startsAt: "2026-10-04" });
    expect(result.id).toBe("game-night-2026-10-04");
  });
});
