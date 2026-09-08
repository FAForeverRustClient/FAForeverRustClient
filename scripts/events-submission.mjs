// Turning a submitted issue into a calendar entry.
//
// The other half of the client's submission form: the form composes a fenced
// `json` block containing the finished catalogue entry, and this reads that
// block out of the issue body, checks it, and writes it into `calendar.json`.
// A workflow in the catalogue repository runs it and comments the result, so
// accepting a submission is a click rather than somebody retyping a date in
// UTC by hand.
//
// A block rather than the issue *form* fields, which was the first idea and is
// worse: GitHub renders a form as "### Question\n\nanswer", so parsing it means
// matching on question wording, in whatever language the form is in, and it
// breaks silently the day somebody rewords a label. The block is the thing
// being submitted.
//
// Usage:
//   node scripts/events-submission.mjs --body-file body.md --calendar calendar.json
//   node scripts/events-submission.mjs --body-file body.md --dry-run

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const CATEGORIES = ["patch", "tournament", "meetup", "cgn", "ladderPool", "other"];
const ORIGINS = ["official", "community"];

/** The prefix the Discord bot owns. A submission may not write into it. */
const BOT_PREFIX = "discord-";

/** Fields a submitted entry may state. Anything else is dropped. */
const ALLOWED = new Set([
  "id",
  "title",
  "summary",
  "category",
  "origin",
  "host",
  "startsAt",
  "endsAt",
  "allDay",
  "recurrence",
  "recursUntil",
  "links",
]);

/**
 * The first fenced `json` block of an issue body, parsed.
 *
 * Returns `null` when there is none, which is not an error: somebody wrote the
 * issue by hand and a maintainer will deal with it. Returns a problem when
 * there is a block and it does not parse, which is worth saying out loud.
 */
export function extractEntry(body) {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(String(body ?? ""));
  if (!match) return { entry: null, problems: [] };
  try {
    const entry = JSON.parse(match[1]);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { entry: null, problems: ["the json block is not an object"] };
    }
    return { entry, problems: [] };
  } catch (error) {
    return { entry: null, problems: [`the json block does not parse: ${error.message}`] };
  }
}

/** Whether a value is `YYYY-MM-DD` or something `Date.parse` understands. */
function readableMoment(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  return !Number.isNaN(Date.parse(value.trim()));
}

/**
 * What is wrong with a submitted entry, as a list of sentences.
 *
 * The client's form has already checked most of this, and that is exactly why
 * it is checked again: the block is editable text in a public issue, and the
 * next step after this commits it.
 */
export function validateEntry(entry) {
  const problems = [];
  if (!String(entry.title ?? "").trim()) problems.push("no title");
  if (!readableMoment(entry.startsAt)) {
    problems.push("startsAt is missing, or is not a date or a timestamp");
  }
  if (entry.endsAt !== undefined && !readableMoment(entry.endsAt)) {
    problems.push("endsAt is not a date or a timestamp");
  }
  if (entry.recursUntil !== undefined && !readableMoment(entry.recursUntil)) {
    problems.push("recursUntil is not a date or a timestamp");
  }
  if (String(entry.id ?? "").startsWith(BOT_PREFIX)) {
    problems.push(`an id may not begin with "${BOT_PREFIX}": those belong to the Discord bot`);
  }
  if (entry.category !== undefined && !CATEGORIES.includes(entry.category)) {
    problems.push(`category "${entry.category}" is not one of ${CATEGORIES.join(", ")}`);
  }
  if (entry.origin !== undefined && !ORIGINS.includes(entry.origin)) {
    problems.push(`origin "${entry.origin}" is not one of ${ORIGINS.join(", ")}`);
  }
  if (entry.links !== undefined) {
    if (!Array.isArray(entry.links)) problems.push("links is not a list");
    else {
      for (const link of entry.links) {
        if (!String(link?.url ?? "").startsWith("https://")) {
          problems.push(`link "${link?.url}" is not a plain https address`);
        }
      }
    }
  }
  const unknown = Object.keys(entry).filter((key) => !ALLOWED.has(key));
  if (unknown.length > 0) problems.push(`unknown field(s): ${unknown.join(", ")}`);
  return problems;
}

/** A URL-safe id from a title and a start, for an entry that gave none. */
export function derivedId(entry) {
  const slug = String(entry.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const day = String(entry.startsAt ?? "").slice(0, 10);
  return slug ? `${slug}-${day}` : day;
}

/**
 * The document with the submission in it, and what happened.
 *
 * An id already in the document gets a suffix rather than overwriting: two
 * clubs can both run a "Game night" on the same evening, and a submission is
 * never allowed to edit an entry somebody else put there. Resubmitting the
 * identical entry changes nothing, so a workflow that runs twice on one issue
 * does not add it twice.
 */
export function mergeSubmission(calendar, entry) {
  const events = [...(calendar.events ?? [])];
  const wanted = String(entry.id ?? "").trim() || derivedId(entry);
  const same = withoutId(entry);
  const duplicate = events.find((existing) => withoutId(existing) === same);
  if (duplicate) {
    return { calendar: { ...calendar, events }, id: duplicate.id, added: false };
  }

  let id = wanted;
  for (let suffix = 2; events.some((existing) => existing.id === id); suffix += 1) {
    id = `${wanted}-${suffix}`;
  }
  events.push({ ...entry, id });
  events.sort((left, right) => {
    const byStart = String(left.startsAt ?? "").localeCompare(String(right.startsAt ?? ""));
    return byStart !== 0 ? byStart : String(left.id).localeCompare(String(right.id));
  });
  return { calendar: { ...calendar, events }, id, added: true };
}

/**
 * An entry as a comparable string, ignoring its id.
 *
 * Keys sorted, because two documents can state the same entry in a different
 * order and "the same submission twice" has to be recognised either way.
 */
function withoutId(event) {
  const pairs = Object.entries(event)
    .filter(([key]) => key !== "id")
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(pairs);
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

async function main() {
  const bodyPath = argument("body-file");
  if (typeof bodyPath !== "string") {
    throw new Error("--body-file is required");
  }
  const dryRun = argument("dry-run", false) !== false;
  const calendarPath = resolve(String(argument("calendar", "calendar.json")));

  const { entry, problems: readProblems } = extractEntry(await readFile(bodyPath, "utf8"));
  if (entry === null) {
    if (readProblems.length === 0) {
      // Deliberately successful: an issue written by hand is a perfectly good
      // submission, it just needs a person. Failing here would put a red cross
      // on somebody's first contribution.
      console.log("NO_BLOCK");
      return;
    }
    throw new Error(readProblems.join("\n"));
  }

  const problems = validateEntry(entry);
  if (problems.length > 0) {
    throw new Error(problems.map((problem) => `- ${problem}`).join("\n"));
  }

  const calendar = JSON.parse(await readFile(calendarPath, "utf8").catch(() => "{}"));
  const result = mergeSubmission(calendar, entry);
  if (!result.added) {
    console.log(`UNCHANGED ${result.id}`);
    return;
  }
  const document = `${JSON.stringify(result.calendar, null, 2)}\n`;
  if (dryRun) {
    console.log(document);
    return;
  }
  await writeFile(calendarPath, document, "utf8");
  console.log(`ADDED ${result.id}`);
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
