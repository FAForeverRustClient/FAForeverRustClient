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

The Discord bot the issue thread discusses, reading a guild's scheduled events
and forwarding them, is not a second source: when it exists it commits into this
same document. That is the point of the document being the boundary rather than
the bot.

---

## Repository layout

The repository exists: [`FAForeverRustClient/events`](https://github.com/FAForeverRustClient/events).

```
events/                           FAForeverRustClient/events
├─ README.md                      how to add an event, for people who will
├─ calendar.json                  THE document the client fetches
└─ .github/
   ├─ ISSUE_TEMPLATE/
   │  └─ event-submission.yml     the form a submission is filled in on
   └─ workflows/
      └─ validate.yml             refuse an entry with no title, start or https link
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
