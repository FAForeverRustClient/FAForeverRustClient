// The events bot: Discord scheduled events into the community calendar.
//
// This is the bot the thread on issue #103 asked for, and it is deliberately
// not the bot that thread first described. That one was to read an
// announcements channel and pick the announcements out of it, which needs the
// Message Content intent (a privileged intent Discord reviews an application
// for) and then needs to parse English prose into a date. Guild **scheduled
// events** are the same information as structured metadata: a name, a start, an
// end, and a recurrence rule. No privileged intent, no text parsing, and the
// organiser has already told Discord when the thing is.
//
// It writes the calendar document the client reads (see
// `docs/events-catalogue.md`). It owns only the entries whose id begins with
// `discord-`: every hand-written entry in the document is left exactly as it
// was, so the two ways of adding an event do not fight over one file.
//
// Usage:
//   node scripts/events-bot.mjs --sources sources.json --calendar calendar.json
//   node scripts/events-bot.mjs --sources sources.json --dry-run
//
// Needs `DISCORD_BOT_TOKEN` in the environment. Nothing else, and the token is
// never written anywhere: it is read once and used for the request.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = "https://discord.com/api/v10";

/** The id prefix this bot owns. Everything else in the document is somebody's. */
const OWNED_PREFIX = "discord-";

/**
 * Discord's `GuildScheduledEventStatus`. Only the first two are on a calendar:
 * a completed event is history and a cancelled one is not happening.
 */
const STATUS_SCHEDULED = 1;
const STATUS_ACTIVE = 2;

/**
 * Discord's `GuildScheduledEventRecurrenceRuleFrequency`.
 *
 * The client's catalogue understands weekly and monthly, which is what the
 * thread asked for: a game night and a rotation. Daily and yearly are mapped to
 * no rule at all rather than to the wrong one, and the entry is still published
 * as its next occurrence, which is what `scheduled_start_time` holds.
 */
const FREQUENCY_MONTHLY = 1;
const FREQUENCY_WEEKLY = 2;

/**
 * FAF's tournament service, the one the client's Tournaments tab reads
 * (`DEFAULT_API_BASE` in `crates/faf-app/src/infra/tourney.rs`).
 *
 * This is here because of what a club's Discord actually looks like. The Dojo
 * announces its tournaments as scheduled events on its own server, and those
 * tournaments are *also* registered with FAF's tournament service, which is
 * where the Tournaments tab and therefore the calendar already draw them from.
 * Mirroring the Discord copy as well puts two squares on one afternoon for one
 * tournament.
 *
 * A tournament's own page on that service is the marker: the announcement links
 * to it, because that is where people sign up. That link is a fact about the
 * event rather than a guess about its title, which is why it is matched on
 * instead of the name: "Average Joe Olympics #6" contains neither the word
 * tournament nor cup, and matching prose would drop game nights whose
 * description happens to mention one.
 */
const TOURNEY_SERVICE_HOSTS = ["tournaments.doodlepros.com"];

/**
 * Whether Discord's copy of this event is a tournament the client already has.
 *
 * The description and the location, which is where an organiser puts the signup
 * address. A server that wants its tournaments mirrored anyway (one whose
 * events are not registered with the service, say) sets `mirrorTournaments` on
 * its source.
 */
export function alreadyATournament(event, source) {
  if (source?.mirrorTournaments === true) return false;
  const text =
    `${event.description ?? ""} ${event.entity_metadata?.location ?? ""}`.toLowerCase();
  return TOURNEY_SERVICE_HOSTS.some((host) => text.includes(`${host}/t/`));
}

/** Whether Discord still considers the event upcoming or running. */
function isLive(event) {
  return event.status === STATUS_SCHEDULED || event.status === STATUS_ACTIVE;
}

/** Cut a Discord description down to something a calendar chip can hold. */
const SUMMARY_LIMIT = 280;

export function summaryOf(description) {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…` : text;
}

/**
 * The catalogue's recurrence rule for a Discord one, or `null`.
 *
 * `by_weekday` and friends are deliberately ignored. Discord allows a rule to
 * name several weekdays; the catalogue's weekly rule repeats on the weekday its
 * first occurrence falls on, so a two-days-a-week event would lose one of them.
 * Publishing the next occurrence with no rule is wrong in a way a reader can
 * see (one entry, not two), where inventing a rule is wrong in a way they
 * cannot.
 */
export function recurrenceOf(rule) {
  if (!rule || typeof rule !== "object") return null;
  const interval = Number.isInteger(rule.interval) && rule.interval > 0 ? rule.interval : 1;
  if (rule.frequency === FREQUENCY_WEEKLY) {
    if (Array.isArray(rule.by_weekday) && rule.by_weekday.length > 1) return null;
    return { weekly: { interval } };
  }
  if (rule.frequency === FREQUENCY_MONTHLY) {
    // The catalogue's monthly rule is "the same day of the month, every month",
    // so an every-other-month Discord rule is not one of them.
    return interval === 1 ? "monthly" : null;
  }
  return null;
}

/**
 * The first rule of a source whose `match` appears in an event's name, or
 * `null`.
 *
 * Substring matching rather than anything cleverer, because the input is a name
 * a human typed and the output is a colour on a chip: being wrong costs a
 * misfiled entry, not a wrong date.
 */
export function ruleFor(name, source) {
  const haystack = (name ?? "").toLowerCase();
  return (
    (source.rules ?? []).find(
      (rule) => rule.match && haystack.includes(String(rule.match).toLowerCase()),
    ) ?? null
  );
}

/**
 * Which category one event's name earns, under one source's rules.
 *
 * First match wins, and the source's own default applies when nothing matches
 * or when the matching rule only said to skip.
 */
export function categoryOf(name, source) {
  return ruleFor(name, source)?.category ?? source.category ?? "other";
}

/**
 * One catalogue entry for one Discord scheduled event, or `null` to skip it.
 *
 * Skipped: anything not scheduled or running; anything without a name or a
 * start, which the client would drop anyway; a tournament the client already
 * draws from the tournament service; and anything a source's rules say to skip
 * by name, which is the escape hatch for a duplicate this cannot see. That is a
 * line in `sources.json` rather than a change here, so nobody waits on a
 * client.
 */
export function entryOf(event, source) {
  if (!isLive(event)) return null;
  const title = (event.name ?? "").trim();
  if (!title || !event.scheduled_start_time) return null;
  if (alreadyATournament(event, source)) return null;
  if (ruleFor(title, source)?.skip) return null;

  const links = [
    {
      label: "Event on Discord",
      url: `https://discord.com/events/${source.guildId}/${event.id}`,
    },
  ];
  // The invite second, and only when the source names one: somebody who is not
  // in the server cannot open the event link at all, and the invite is the way
  // in. An external event's location goes on as a third link when it is a URL,
  // which is how Discord carries "we are streaming here".
  if (source.invite) links.push({ label: `Join ${source.host}`, url: source.invite });
  const location = event.entity_metadata?.location?.trim();
  if (location && location.startsWith("https://")) {
    links.push({ label: "Where", url: location });
  }

  const entry = {
    id: `${OWNED_PREFIX}${source.guildId}-${event.id}`,
    title,
    summary: summaryOf(event.description),
    category: categoryOf(title, source),
    origin: source.origin ?? "community",
    host: source.host ?? "",
    startsAt: event.scheduled_start_time,
    links,
  };
  if (event.scheduled_end_time) entry.endsAt = event.scheduled_end_time;
  const recurrence = recurrenceOf(event.recurrence_rule);
  if (recurrence) {
    entry.recurrence = recurrence;
    if (event.recurrence_rule?.end) entry.recursUntil = event.recurrence_rule.end;
  }
  return entry;
}

/**
 * The document to publish: the hand-written entries, unchanged, plus ours.
 *
 * Sorted by start so a human reading a diff can see what moved, and so the file
 * does not churn on the order Discord happened to answer in.
 */
export function mergeCalendar(existing, ours) {
  const kept = (existing.events ?? []).filter(
    (event) => !String(event.id ?? "").startsWith(OWNED_PREFIX),
  );
  const events = [...kept, ...ours].sort((left, right) => {
    const byStart = String(left.startsAt ?? "").localeCompare(String(right.startsAt ?? ""));
    return byStart !== 0 ? byStart : String(left.id).localeCompare(String(right.id));
  });
  return { ...existing, events };
}

async function fetchScheduledEvents(guildId, token) {
  const response = await fetch(`${API}/guilds/${guildId}/scheduled-events`, {
    headers: { authorization: `Bot ${token}`, "user-agent": "faf-events-bot" },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Discord answered ${response.status} for guild ${guildId}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  return response.json();
}

function argument(name, fallback = null) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

async function main() {
  const dryRun = argument("dry-run", false) !== false;
  const sourcesPath = resolve(String(argument("sources", "sources.json")));
  const calendarPath = resolve(String(argument("calendar", "calendar.json")));
  const token = process.env.DISCORD_BOT_TOKEN?.trim();

  const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
  const guilds = (sources.guilds ?? []).filter((guild) => guild.guildId && guild.enabled !== false);
  if (guilds.length === 0) {
    console.log(`No enabled guilds in ${sourcesPath}; nothing to do.`);
    return;
  }
  if (!token) {
    // Not a failure. The workflow that runs this is scheduled before anybody
    // has necessarily added the secret, and a red run every night would train
    // whoever owns the repository to ignore it.
    console.log("DISCORD_BOT_TOKEN is not set; skipping. See docs/events-catalogue.md.");
    return;
  }

  const ours = [];
  const failures = [];
  for (const source of guilds) {
    try {
      const events = await fetchScheduledEvents(source.guildId, token);
      const mapped = events.map((event) => entryOf(event, source)).filter(Boolean);
      // The tournament count on the same line as the total: an organiser who
      // looks for tonight's tournament on the calendar and does not find it is
      // owed the reason, and the run summary is where they will look.
      const tournaments = events.filter(
        (event) => isLive(event) && alreadyATournament(event, source),
      ).length;
      const already = tournaments > 0 ? `, ${tournaments} already in the Tournaments tab` : "";
      console.log(
        `${source.host ?? source.guildId}: ${mapped.length} of ${events.length} events${already}`,
      );
      ours.push(...mapped);
    } catch (error) {
      // One unreachable server must not blank the others' events, and it must
      // not publish a document that quietly lost half its entries either.
      failures.push(`${source.host ?? source.guildId}: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`could not read every source, so nothing was written:\n${failures.join("\n")}`);
  }

  const existing = JSON.parse(await readFile(calendarPath, "utf8").catch(() => "{}"));
  const merged = mergeCalendar(existing, ours);
  const document = `${JSON.stringify(merged, null, 2)}\n`;
  if (dryRun) {
    console.log(document);
    return;
  }
  await writeFile(calendarPath, document, "utf8");
  console.log(`Wrote ${merged.events.length} events to ${calendarPath}.`);
}

// Importable for the tests, runnable as a script. `process.argv[1]` is the
// script itself only when it was started directly.
if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
