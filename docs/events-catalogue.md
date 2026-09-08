# The events catalogue: repository layout and manifest format

The Events tab draws three kinds of thing, and only one of them is published as
a document. This is the contract for that document, so the calendar can be
filled in without touching the client.

| What | Where it comes from | Needs |
|---|---|---|
| Tournaments | `TourneyPort`, already read by the client | nothing, works today |
| Released patches | the changelog index, already parsed by the client | nothing, works today |
| Ladder pool rotation | a recurrence rule, shipped with the client | nothing |
| CGN, meetups, game nights, an announced patch date | **this document** | one commit per event |

The document lives at `FAF_EVENTS_CATALOGUE_URL`, which defaults to
`https://raw.githubusercontent.com/FAForeverRustClient/events/main/calendar.json`.
A client that cannot read it falls back to the copy in
`crates/faf-app/src/infra/events_catalogue.json` and says so under the calendar.

---

## Why a Git repository

The same reasoning as [`training-catalogue.md`](training-catalogue.md), and the
same answer, so the two are worth reading together. In short: a service to write,
host and secure, for content that is a date and a title, is not a trade worth
making, and a Git repository gives versioning, a CDN, an audit trail in the
commit log and an author list for free.

What is specific to events: **nothing here is authoritative**. A game night is
whatever the club that runs it says it is, and the client's copy of that is a
convenience. So the format is deliberately lenient (see below), and every entry
carries links back to wherever the real answer lives.

The Discord bot is not a second source: it commits into this same document.
That is the point of the document being the boundary rather than the bot, and it
is documented in its own section below.

---

## Repository layout

The repository exists: [`FAForeverRustClient/events`](https://github.com/FAForeverRustClient/events).

```
events/                           FAForeverRustClient/events
├─ README.md                      how to add an event, for people who will
├─ calendar.json                  THE document the client fetches
├─ sources.json                   which Discord servers the bot mirrors
├─ DISCORD-SETUP.md               step by step, for whoever enables a server
└─ .github/
   ├─ ISSUE_TEMPLATE/
   │  └─ event-submission.md      the same entry block, for a submission by hand
   └─ workflows/
      ├─ validate.yml             refuse an entry with no title, start or https link
      ├─ submissions.yml          check an issue, and apply it once approved
      └─ discord-events.yml       the bot, four times a day
```

`calendar.json` is the only file the client reads.

---

## The manifest

```json
{
  "submitUrl": "https://github.com/FAForeverRustClient/events/issues/new/choose",
  "events": [
    {
      "id": "dojo-1v1-night",
      "title": "Dojo 1v1 Night",
      "summary": "Casual 1v1s, all ratings. Sign-ups in the Discord.",
      "category": "meetup",
      "origin": "community",
      "host": "FAF Dojo",
      "startsAt": "2026-09-12T18:00:00Z",
      "endsAt": "2026-09-12T22:00:00Z",
      "recurrence": { "weekly": { "interval": 1 } },
      "recursUntil": "2026-12-31",
      "links": [
        { "label": "Join the Discord", "url": "https://discord.gg/example" }
      ]
    }
  ]
}
```

### Fields

| Field | Meaning |
|---|---|
| `id` | Stable within the document. Reminders are stored against it, so **renaming an id drops the reminders people set on that event**. Omit it and one is derived from the title and the start, which is stable as long as neither changes. |
| `title` | Required. An entry without one is dropped. |
| `summary` | One or two sentences. Plain text: the calendar renders no markup. |
| `category` | `patch`, `tournament`, `meetup`, `cgn`, `ladderPool`, or `other`. Anything else reads as `other` rather than failing. |
| `origin` | `official` for FAF itself, `community` for anybody else. Defaults to `community`. |
| `host` | Who is running it, in their own words. |
| `startsAt` | Required. Either a full RFC 3339 timestamp (`2026-09-12T18:00:00Z`) or a bare date (`2026-09-12`). |
| `endsAt` | Optional, same two forms. |
| `allDay` | Optional. Inferred from `startsAt`: a bare date is a day, a timestamp is a moment. State it to override. |
| `recurrence` | `{ "weekly": { "interval": 1 } }` or `"monthly"`. Absent for a one-off. |
| `recursUntil` | When repeating stops. Absent means open-ended. |
| `links` | Buttons on the entry. Each needs an `https` `url`; anything else is dropped and the rest of the entry kept. |

### Times

**Write times in UTC.** The client renders every one of them in the reader's own
time zone, which is the whole point: nobody should be doing arithmetic to find
out whether a 19:00 game night is 19:00 for them.

Two consequences worth knowing:

- A **bare date** is a date. It is drawn with no time and is never converted, so
  a patch released "on the 14th" is the 14th in Auckland too. Use a bare date
  for anything that is a day rather than a moment.
- A **recurring** event keeps its UTC instant, so its local time moves by an
  hour across a daylight-saving change. If a weekly event is meant to stay at
  19:00 local through the year, split it at the changeover: end the rule with
  `recursUntil` and add a second entry with the new time.

### Leniency

Every field except `title` and `startsAt` has a default, unknown fields are
ignored, and one malformed entry is dropped rather than sinking the document.
That is deliberate: this file is edited by hand, and a strict parser would turn
a typo into an empty calendar for everybody. The client's own state stays
complete; the leniency is at the boundary, in
`crates/faf-app/src/infra/events.rs`.

### Size

A manifest over 1 MB is refused as a wrong URL. For scale, the example above is
about 500 bytes, so that is a few thousand events.

---

## The Discord bot

`scripts/events-bot.mjs` in **this** repository, run by a workflow in the
catalogue repository four times a day. It reads the **guild scheduled events** of
every server listed in that repository's `sources.json` and writes them into
`calendar.json`.

### Why scheduled events and not announcements

The issue thread's first plan was a bot that reads a server's announcements
channel and picks the event announcements out of it. That needs Discord's
**Message Content** intent, which is privileged and reviewed per application,
and it then needs to parse English prose into a date and a recurrence. A guild
scheduled event is the same information as structured metadata that the
organiser has already filled in: `name`, `description`,
`scheduled_start_time`, `scheduled_end_time` and `recurrence_rule`. No
privileged intent, no parsing, and nothing the bot can see is a conversation.

The endpoint is `GET /guilds/{guild.id}/scheduled-events`. Reading it needs the
bot in the server with `View Channels`, which the default role has; **Manage
Events** is a write permission and is deliberately not requested.

### What it owns

Every entry whose `id` begins with `discord-`, and nothing else. Hand-written
entries in `calendar.json` are left exactly as they are, so the two ways of
adding an event never fight over one file. An event deleted on Discord
disappears from the calendar on the next run, which is the reason the bot owns
its ids rather than appending to the list.

An event that is `COMPLETED` or `CANCELED` on Discord is not published, and one
run that cannot reach one of its servers writes nothing at all rather than a
document that quietly lost that server's events.

### What it does not publish: tournaments

A club announces its tournaments as scheduled events on its own server, and
registers those same tournaments with FAF's tournament service. The calendar
already draws that service's tournaments out of `TourneyState`, so mirroring the
Discord copy as well puts **two squares on one afternoon for one tournament**.

So a scheduled event that links to a tournament on
`tournaments.doodlepros.com/t/…`, in its description or its location, is not
mirrored. The link is the marker rather than the title: it is a fact about the
event, where "Average Joe Olympics #6" contains neither the word tournament nor
the word cup, and matching on prose would also drop a game night whose
description merely mentions one.

Two dials in `sources.json`, both of them a commit in the calendar repository
rather than a client release:

| In a source | Effect |
|---|---|
| `"mirrorTournaments": true` | Mirror them anyway. For a server whose tournaments are not registered with the service, and which would otherwise lose them. |
| `"rules": [{ "match": "…", "skip": true }]` | Do not mirror an event whose name contains this. The escape hatch for a duplicate no link betrays. |

A `skip` rule that names no category leaves the category alone, so it can sit in
the same list as the colour rules.

The run summary counts them: `FAF Dojo: 1 of 6 events, 5 already in the
Tournaments tab`. An organiser who cannot find tonight's tournament on the
calendar is owed that line.

### Recurrence, and where it stops

| Discord rule | What is published |
|---|---|
| Weekly, one weekday, interval N | `{ "weekly": { "interval": N } }` |
| Monthly, interval 1 | `"monthly"` |
| Anything else | the next occurrence, with no rule |

"Anything else" is daily, yearly, every-other-month, and a weekly rule naming
more than one weekday. The catalogue's weekly rule repeats on the weekday of its
first occurrence, so a Tuesday-and-Thursday event would silently lose one of the
two. One entry with no rule is wrong in a way a reader can see; an invented
series is wrong in a way they cannot. Split such an event on Discord instead.

### Running it by hand

```bash
node scripts/events-bot.mjs --sources sources.json --calendar calendar.json --dry-run
```

`DISCORD_BOT_TOKEN` in the environment, nothing else. With no token, or with no
enabled server in `sources.json`, it says so and exits successfully: the
scheduled workflow is in place before anybody has necessarily configured a
server, and a red run every six hours would train whoever owns the repository to
ignore it.

The mapping is unit tested in `scripts/events-bot.test.mjs`, which is why
`vitest.config.ts` reaches into `scripts/` for exactly that one file: publishing
a wrong date to every client is not something to find out about from a player.

---

## Submitting an event

The Events tab has a **Suggest an event** button, and what it opens is a form
rather than a browser. That is the point: nobody should have to know this
document's format, convert their own evening into UTC, or remember how a
fortnightly rule is spelled.

The path, end to end:

1. `EventSubmitDialog` asks what the catalogue needs, in the player's own time
   zone. `eventSubmission.ts` converts it, and the dialog shows the entry it
   built, so somebody who does know the format can check it.
2. The button opens `github.com/<owner>/<repo>/issues/new` with the title, the
   labels and a body already filled in. The body carries a sentence for whoever
   reads the issue and the entry itself in a fenced `json` block. The client
   does not post it: it has no GitHub identity, and the last step being the
   player's own click is what keeps a submission attributable to them.
3. In the catalogue repository, `submissions.yml` runs `events-submission.mjs`
   on every issue carrying such a block and comments whether it reads cleanly.
4. A maintainer adds the `approved` label. That commits the entry and closes the
   issue.

The block rather than the issue *form* fields, and that is worth stating because
a form was the first design. GitHub renders a form as `### Question` followed by
the answer, so reading one back means matching on question wording, in whichever
language somebody wrote the form, and it breaks silently the day a label is
reworded. The block is the thing being submitted, so it is what is read.

The label is the one step that is not automated. Automating the transcription is
what this is for; automating the decision would mean anybody who can open an
issue can put anything on every player's calendar.

Two rules protect what is already there. A submission may not claim an id
beginning with `discord-`, because those belong to the mirror bot and the next
run would overwrite it. An id already in the document gets a numeric suffix
rather than replacing the entry that holds it, so a submission can never edit
somebody else's. Submitting the identical entry twice changes nothing, which is
what makes the workflow safe to re-run on an edited issue.

An issue with no block in it is not an error. Somebody wrote it by hand, and it
is left for a maintainer rather than refused: a red cross on a first
contribution is a worse outcome than a minute of transcription.

---

## What the client does not read from here

- **Attendance.** There is no "I will participate" on an entry, because nothing
  would carry it: FAF has no events service, and a document in a Git repository
  is not one. Tournaments do have real signups, and their entries link into the
  Tournaments tab, where signing up already works.
- **Chat and polls.** Both were asked for on the issue. Both need a service.
  The links on an entry are how a reader gets to where the conversation is
  actually happening.
- **Reminders.** Set in the client, kept in the client's own settings file, and
  never sent anywhere.

One note on the submission link. `submitUrl` is offered by the tab only when the
catalogue was actually read from the network. The copy that ships inside the
client names no address at all, because it is used precisely when the published
document could not be read, which is the state in which a button into that
document's repository is least likely to answer. The button was a 404 before
that rule existed.
