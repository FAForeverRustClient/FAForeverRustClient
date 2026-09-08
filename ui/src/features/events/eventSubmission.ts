// Composing an event submission: from a form in the client to a catalogue
// entry a bot can commit without anybody retyping it.
//
// The problem this solves. "Suggest an event" used to open an empty GitHub
// issue form, and somebody then had to read prose out of it and hand-write a
// JSON entry, getting the UTC conversion and the recurrence spelling right. So
// the client does that part: the form knows what a catalogue entry needs, the
// conversion happens here, and the issue it opens carries the finished entry in
// a fenced `json` block. The workflow in the catalogue repository reads that
// block, validates it and commits it (see `scripts/events-submission.mjs`).
//
// The client never posts the issue itself. It has no GitHub identity and
// posting in somebody's name is not something this client does: the player
// lands on a prefilled issue in their own browser and presses the button. Same
// shape as the training hub's submission path.

import type { EventCategory, EventOrigin } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";

/** How often the event repeats, in the three shapes the catalogue can express. */
export type DraftRecurrence = "none" | "weekly" | "fortnightly" | "monthly";

/** What the form holds. Dates and times are local, as typed. */
export interface EventDraft {
  title: string;
  /** `YYYY-MM-DD`, from a date input. */
  day: string;
  /** `HH:MM`, or empty for a whole-day entry. */
  time: string;
  /** `HH:MM`, or empty. Ignored when `time` is empty. */
  endTime: string;
  category: EventCategory;
  origin: EventOrigin;
  host: string;
  summary: string;
  linkLabel: string;
  linkUrl: string;
  recurrence: DraftRecurrence;
}

export const EMPTY_DRAFT: EventDraft = {
  title: "",
  day: "",
  time: "",
  endTime: "",
  category: "meetup",
  origin: "community",
  host: "",
  summary: "",
  linkLabel: "",
  linkUrl: "",
  recurrence: "none",
};

/** A summary is a line or two on a card, not the event's rules page. */
const SUMMARY_LIMIT = 280;

/** One catalogue entry, as the document holds it. Only what is stated. */
export interface SubmissionEntry {
  id: string;
  title: string;
  category: EventCategory;
  origin: EventOrigin;
  startsAt: string;
  summary?: string;
  host?: string;
  endsAt?: string;
  allDay?: boolean;
  recurrence?: { weekly: { interval: number } } | "monthly";
  links?: { label: string; url: string }[];
}

/**
 * An id derived from the title and the day.
 *
 * Reminders are stored against it, so it has to be stable rather than random,
 * and it has to survive being a key in a JSON document. Same shape the
 * catalogue reader derives for an entry that gives no id.
 */
export function draftId(draft: EventDraft): string {
  const slug = draft.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}-${draft.day}` : draft.day;
}

/** Local `YYYY-MM-DD` plus `HH:MM` as a UTC timestamp, or `null`. */
function utcTimestamp(day: string, time: string): string | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!date || !clock) return null;
  const local = new Date(
    Number(date[1]),
    Number(date[2]) - 1,
    Number(date[3]),
    Number(clock[1]),
    Number(clock[2]),
  );
  if (Number.isNaN(local.getTime())) return null;
  // Seconds and milliseconds trimmed: nobody schedules a game night at 19:00:30
  // and the document is read by people.
  return `${local.toISOString().slice(0, 17)}00Z`;
}

/**
 * What is wrong with the draft, as a message key, or `null` when nothing is.
 *
 * Deliberately short. The catalogue itself is lenient and the workflow validates
 * again, so this is here to stop the two mistakes that produce a *plausible but
 * wrong* entry rather than a rejected one: a date the client cannot convert, and
 * an end before the start.
 */
export function submissionProblem(draft: EventDraft): MessageKey | null {
  if (!draft.title.trim()) return "events.submit.problem.noTitle";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.day.trim())) return "events.submit.problem.noDate";
  if (draft.time.trim() && utcTimestamp(draft.day, draft.time) === null) {
    return "events.submit.problem.noDate";
  }
  if (draft.time.trim() && draft.endTime.trim()) {
    const start = utcTimestamp(draft.day, draft.time);
    const end = utcTimestamp(draft.day, draft.endTime);
    // An end before the start is the one case worth refusing rather than
    // guessing at: a game night that runs past midnight is the same mistake as
    // a typo, and only the person filling the form knows which it is.
    if (start === null || end === null || end <= start) return "events.submit.problem.badEnd";
  }
  if (draft.linkUrl.trim() && !/^https:\/\/\S+$/.test(draft.linkUrl.trim())) {
    return "events.submit.problem.badUrl";
  }
  return null;
}

/** The catalogue entry a valid draft describes. */
export function entryFromDraft(draft: EventDraft): SubmissionEntry {
  const timed = draft.time.trim() !== "";
  const entry: SubmissionEntry = {
    id: draftId(draft),
    title: draft.title.trim(),
    category: draft.category,
    origin: draft.origin,
    startsAt: timed ? (utcTimestamp(draft.day, draft.time) ?? draft.day.trim()) : draft.day.trim(),
  };
  if (draft.summary.trim()) {
    entry.summary = draft.summary.trim().replace(/\s+/g, " ").slice(0, SUMMARY_LIMIT);
  }
  if (draft.host.trim()) entry.host = draft.host.trim();
  if (timed && draft.endTime.trim()) {
    const end = utcTimestamp(draft.day, draft.endTime);
    if (end) entry.endsAt = end;
  }
  // Stated rather than left to be inferred, because the reader of the issue is
  // a person: "allDay": true says what the bare date above means.
  if (!timed) entry.allDay = true;
  if (draft.recurrence === "weekly") entry.recurrence = { weekly: { interval: 1 } };
  if (draft.recurrence === "fortnightly") entry.recurrence = { weekly: { interval: 2 } };
  if (draft.recurrence === "monthly") entry.recurrence = "monthly";
  if (draft.linkUrl.trim()) {
    entry.links = [
      { label: draft.linkLabel.trim() || "Open", url: draft.linkUrl.trim() },
    ];
  }
  return entry;
}

/** The `json` block the workflow reads, exactly as it appears in the issue. */
export function submissionBlock(draft: EventDraft): string {
  return `\`\`\`json\n${JSON.stringify(entryFromDraft(draft), null, 2)}\n\`\`\``;
}

/** The issue title, so both submission paths agree on it. */
export function submissionTitle(draft: EventDraft): string {
  return `Event: ${draft.title.trim()}`;
}

/**
 * The issue body: a sentence for the person reading it, then the block.
 *
 * The prose is not parsed by anything. It is there because an issue nobody can
 * read is a worse issue, and because the sentence states the one thing the
 * block cannot: that the times in it are UTC and were converted from what
 * somebody typed in their own zone.
 */
export function submissionBody(draft: EventDraft): string {
  const entry = entryFromDraft(draft);
  const lines = [
    `Submitted from the FAForever client. The block below is the catalogue entry;`,
    `the bot commits it as it stands, so edit the block rather than the prose.`,
    ``,
    `Times are UTC. ${entry.allDay ? "This is a whole-day entry." : `Local time as entered: ${draft.day} ${draft.time}${draft.endTime ? ` to ${draft.endTime}` : ""}.`}`,
    ``,
    submissionBlock(draft),
  ];
  return lines.join("\n");
}

/**
 * GitHub's new-issue page with the whole submission already in it.
 *
 * `submitUrl` comes from the catalogue document, so it is remote content and is
 * treated as such: only the `github.com/<owner>/<repo>/issues/new` shape is
 * accepted, and anything else returns `null` and the button stays hidden. The
 * template chooser is trimmed off, because a prefilled body needs the plain
 * form rather than a menu.
 */
export function submissionIssueUrl(submitUrl: string, draft: EventDraft): string | null {
  const trimmed = submitUrl.trim().replace(/\/choose\/?$/, "").replace(/\/$/, "");
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/new$/.test(trimmed)) return null;
  const query = new URLSearchParams({
    title: submissionTitle(draft),
    body: submissionBody(draft),
    labels: "event",
  });
  return `${trimmed}?${query.toString()}`;
}
