# The training catalogue: repository layout and manifest format

The Training tab reads its library from a JSON manifest at
`FAF_TRAINING_CATALOGUE_URL`. This is the contract for that document, so the
catalogue can be created and maintained without touching the client.

Nothing here is a client release. Adding a guide, retagging one, adding a
trainer or changing the training Discord invite is a commit in the catalogue
repository and reaches every client on its next load.

---

## Why a Git repository

The alternatives, and why this one:

- **In the client** (a JSON file in the crate): every guide change would need a
  client release. It is also the mistake of putting content in the client that
  belongs behind an API.
- **A service**: the right answer the day submissions need to be written from
  inside the client by people without a GitHub account. Until then it is a
  server to write, host, deploy and secure for content that is text.
- **The FAF API**: `tutorial` and `tutorialCategory` already exist, so tags
  could be added there. That is a schema change to the central database, an API
  change and an admin UI change, and it needs the API team's agreement. Guides
  are prose, not relational data.
- **A Git repository**: no service, no auth to read, CDN-fast, versioned and
  cacheable offline, with the commit log as the audit trail and the
  collaborator list as the trainer list. Note that a submission is an *issue*
  and accepting it commits straight to `main`: there is no pull request in the
  loop, because what needed reviewing was the guide and that already happened
  on the issue.

The repository is `FAForeverRustClient/guides`.

The client already reads a published document from GitHub this way: the
changelog comes from `faforever.github.io/fa/changelog` plus
`raw.githubusercontent.com`, deliberately off GitHub's rate-limited API.

---

## Repository layout

```
guides/                           FAForeverRustClient/guides
├─ README.md                      how to add a guide, for people who will
├─ catalogue.json                 THE manifest the client fetches
├─ guides/
│  ├─ setons-t1-build-order.md    long-form guides, one file each
│  └─ economy-fundamentals.md
└─ .github/
   ├─ ISSUE_TEMPLATE/
   │  └─ training-submission.yml  the form a submission by hand is filled in on
   └─ workflows/
      └─ validate.yml             fail a PR whose manifest does not parse
```

`catalogue.json` is the only file the client reads. Guides under `guides/`
are linked from it by their raw URL, which is what makes them editable as
Markdown rather than as strings inside JSON.

Serve the manifest from
`https://raw.githubusercontent.com/FAForeverRustClient/guides/main/catalogue.json`,
which is what `FAF_TRAINING_CATALOGUE_URL` should be set to.

**Name the branch, do not write `HEAD`.** This document said `HEAD` at first,
on the reasoning that it survives a rename of the default branch. It does, and
it also serves stale content: `raw.githubusercontent.com` caches its resolution
of `HEAD` separately from the file, and no query parameter bypasses that, so a
`HEAD` URL kept answering with the document from before the last commit. `main`
answers with what the branch points at. Both this and GitHub Pages are CDN
served, and neither is rate limited the way the API is.

### The validation workflow earns its place

A manifest is hand-edited, and the client is deliberately forgiving: an entry
with a typo in a field name loses that field silently rather than sinking the
document. That forgiveness is right at runtime and wrong when a change is going in, which
is what `validate.yml` is for. Minimum: the document parses, every `id` is
unique, every `related` id resolves, and every `url` is `https://`.

---

## `catalogue.json`

Everything is optional. The client fills in what a document does not state and
ignores fields it does not know, so this format can gain a field without
breaking older clients, and an older manifest keeps working against a newer
client.

```json
{
  "links": {
    "discordUrl": "https://discord.gg/By9tNUAq8B",
    "replayReviewChannel": "https://discord.com/channels/123.../456...",
    "replayReviewUrl": "https://forum.faforever.com/category/4/i-need-help",
    "replayReviewCategory": 4,
    "contributeUrl": "https://forum.faforever.com/category/4/i-need-help",
    "contributeCategory": 4,
    "wikiUrl": "https://wiki.faforever.com"
  },
  "trainers": [
    {
      "name": "Seraphim-Noob",
      "fafId": 101,
      "role": "Personal trainer",
      "topics": ["economy", "buildOrder"],
      "gameModes": ["1v1", "2v2"],
      "ratingMin": 1000,
      "ratingMax": 1800,
      "languages": ["English", "Deutsch"],
      "discord": "seraphimnoob",
      "note": "Happy to look at ladder games.",
      "accepting": true
    }
  ],
  "resources": [
    {
      "id": "setons-t1-build-order",
      "title": "Seton's Clutch T1 build order",
      "summary": "Four mexes, then land. What to do differently in the middle.",
      "kind": "buildOrder",
      "level": "beginner",
      "url": "https://raw.githubusercontent.com/FAForeverRustClient/guides/main/guides/setons-t1-build-order.md",
      "author": "Someone",
      "ratingMin": 700,
      "ratingMax": 1200,
      "gameModes": ["4v4"],
      "topics": ["buildOrder", "economy"],
      "maps": ["Setons Clutch"],
      "factions": ["uef"],
      "durationMinutes": 8,
      "related": ["economy-fundamentals"],
      "approvedBy": "A trainer",
      "updatedAt": "2026-09-04"
    }
  ]
}
```

### `links`

| Field | Meaning |
| --- | --- |
| `discordUrl` | The training community's invite. An empty value hides the hero's Discord button rather than sending anyone to a guess. |
| `replayReviewChannel` | The channel a replay review is asked in, as a `https://discord.com/channels/<guild>/<channel>` address. Discord's desktop application follows one straight there, and the client copies the request on the way, so the player lands in the right place with one paste left to do. Turn on Developer Mode in Discord and use *Copy Link* on the channel. Empty falls back to the invite. |
| `replayReviewUrl` | Where replay reviews are discussed, for a reader who wants to browse them. The request itself goes to `discordUrl`: Discord is where they are answered, and it cannot take a prefilled message, so the client writes the request and the player pastes it. |
| `replayReviewCategory` | That category as a NodeBB id. Only used for the forum link; a request needs neither. |
| `contributeUrl` / `contributeCategory` | The forum fallback for submissions, used only by a build with no catalogue repository configured. Otherwise a submission is an issue. |
| `wikiUrl` | The wiki's entry point. |

A manifest that omits any of these inherits the value shipped with the client,
so adding resources does not mean restating the destinations.

### `trainers`

Only `name` is required. `accepting` defaults to `true`: a trainer listed at
all is presumed to be coaching, and stepping back is the thing worth writing
down. A paused trainer stays on screen and is marked, because "this person
coaches, just not right now" is more useful than a name that vanished.

`fafId` is the field worth chasing. With it the tile stops being a string: the
player card opens, the real rating and avatar resolve, and the trainer can be
messaged from inside the client. It is the same reason a tournament entrant
carries one.

### `resources`

`id` and `title` are required; an entry missing either is dropped, because the
id is what `related` and the recommendation list address it by and a nameless
row is not something a reader can act on.

| Field | Values |
| --- | --- |
| `kind` | `video`, `guide`, `buildOrder`, `replayAnalysis`, `lesson`, `community`. Defaults to `guide`. |
| `level` | `beginner`, `intermediate`, `advanced`, or absent. |
| `topics` | `economy`, `buildOrder`, `micro`, `strategy`, `armyComposition`, `mapControl`, `scouting`, `factions`, `teamplay`, `interface`. A closed set on purpose: free tags produce forty near-synonyms nobody can filter by. |
| `gameModes` | Free text (`1v1`, `4v4`, `custom`, `coop`, a mod's own queue). The filter offers whatever the catalogue contains. `custom` means a game outside the matchmaker and is the one word with a rule behind it: see below. |
| `maps` | Map names as a player reads them. Matched case-insensitively and by substring, so `Setons Clutch`, `SCMP_009` and "Seton's" find each other. |
| `ratingMin` / `ratingMax` | Either may be absent, and an absent bound is open. Stated numbers win over the band a `level` implies. |
| `related` | Other resource ids. This is what makes the library a graph rather than a list: a guide about a mistake can point at the lesson that fixes it. Ids that no longer resolve are dropped rather than drawn as dead rows. |
| `approvedBy` | Who vouched for it. Rendered as "Reviewed by", never "official": accepting a guide is not the same as having checked every sentence, and a label implying otherwise is worse than none. |

### `custom`, and why most team material needs it

FAF keeps five ratings, and the client judges an entry by the one its modes
name. `4v4` is the *matchmaker* 4v4 leaderboard. Most of what the community
teaches is not matchmaker material at all: Seton's, Dual Gap and the rest are
lobby games, rated on the leaderboard FAF calls `global`. An entry tagged only
`4v4` is therefore measured against a queue its reader may never have entered,
and often against no rating at all.

So the catalogue says `custom`, which is the word used in a lobby, and the
client resolves it to the `global` leaderboard. The two are interchangeable
everywhere: choosing either in the filter finds both.

**Pair it with a team size, `custom` first:**

```json
{ "gameModes": ["custom", "4v4"] }
```

The order decides the rating, because the first mode that resolves wins, and
`custom` resolving first is the point. The size is still worth stating second:
the profile is read from local replay headers, and a replay header records how
many players were in the game and not whether the matchmaker put them there. So
`4v4` is what actually matches a Seton's player's recent games, while `custom`
is what picks the right rating for them.

### Reading a guide inside the client

A guide this repository hosts is fetched and rendered in the tab. Nothing else
is: every other entry is somebody else's page, behind their own styling, their
own login and their own frame policy, and those open in a browser.

Link a hosted guide by its **raw** address:

```json
{ "url": "https://raw.githubusercontent.com/FAForeverRustClient/guides/main/guides/x.md" }
```

Raw is what the client reads. A reader who presses the button to open it in a
browser anyway is sent to the `github.com/.../blob/...` address instead, which
is the rendered one; raw serves `text/plain`, which is a build order as a wall
of monospace.

The client decides for itself whether an entry is readable, by checking that
the address is Markdown in the repository that build is configured to trust. A
manifest cannot claim it: a catalogue is remote content, and the addresses in it
decide what is offered, never what the client is willing to fetch. That
conclusion travels to the UI as a `readable` field on the resource, and is
deliberately **not** written back into this file when a submission is accepted.

A video entry is played in the tab as well, through
`www.youtube-nocookie.com`, which is the only video host the client's frame
policy allows. An uploader who has disabled embedding gets a frame saying so.

### Tagging a FAF lesson

FAF's own tutorial API fills part of the library at runtime, and it carries
none of the metadata above, so the client infers tags from the words the author
wrote. To replace that guess, add a resource with the lesson's `tutorialId`:

```json
{ "id": "faf-lesson-7-retagged", "title": "Economy basics", "tutorialId": 7,
  "level": "beginner", "topics": ["economy"], "gameModes": ["1v1"] }
```

Such an entry replaces the derived one **wholesale** rather than merging field
by field. Half a merge would be worse than either half: an entry whose tags
come from a curator and whose level comes from a keyword table is not something
anyone can reason about.

---

## Submissions and moderation

Both halves run inside the client. This section is the contract between them.

### What a submission looks like

A submission is a GitHub issue labelled `training-submission`. Its body is a
**filled-in form**, which is exactly what GitHub renders when somebody answers
an issue form: a `### ` heading per field, then the answer.

```
### Summary

Four mexes, then land. What to do differently in the middle.

### Link

_No response_

### Guide

## Opening

Four mexes, then a land factory.

### Type

Build order

### Topics

- [x] Build orders
- [x] Economy

### Rating from

700
```

That one shape serves both submission paths. The client writes it when it opens
an issue itself; GitHub writes it when somebody fills in
`.github/ISSUE_TEMPLATE/training-submission.yml`. The queue never has to know
which it is reading, and a maintainer can accept either in one press.

**No JSON, and no id.** An earlier version of this put a serialised catalogue
entry in a fenced block and asked the submitter to edit it, which is the wrong
surface for the one job that has to be easy. The author writes prose and picks
from lists; the id is derived from the issue title, because an id is a file
name and the key `related` points at, and asking a submitter to invent a stable
identifier is asking the wrong person. A maintainer who wants a different id
edits the title before accepting.

The field labels are a contract between `mod field` in
`crates/faf-domain/src/state/guides.rs` and the `label:` values in the issue
form. Renaming one on either side alone silently drops that answer from every
submission opened in a browser. The dropdown options are the same strings
`kind_label` and `level_label` produce, and the parser reads them back through
those same functions, so there is one table rather than two that can disagree.

Two answers mean something specific:

- `_No response_` is how GitHub writes an unanswered optional field, and it
  reads back as absent rather than as that literal string.
- `Any` on the level dropdown is a real answer, not a missing one. The
  catalogue treats an unstated level as an open band, so one option covers
  both.

An issue somebody typed freehand carries no form at all. It is still listed and
still readable in the queue; it just cannot be accepted in one step, and the
client says so rather than offering a button that would do nothing.

### What accepting does

1. commits `guides/<id>.md`, if the submission carried a written guide, and
   points the entry's `url` at its raw address;
2. reads `catalogue.json`, adds the entry (replacing an entry with the same id,
   so a corrected resubmission does not produce two), commits it;
3. comments on the issue saying where it landed, and closes it.

The commit is guarded by the file's content hash: if somebody committed in
between, GitHub refuses rather than overwriting them, and the client re-reads
and retries once. Declining comments the reason and closes the issue.

One cosmetic consequence worth knowing: the client re-serialises
`catalogue.json` through a JSON parser, which sorts object keys. The first
accepted submission will therefore reorder the whole file once, and it stays
stable afterwards. Comment keys (`//`) and anything else the client does not
model survive: the document is patched as a generic JSON value, never round
tripped through the client's own types.

### Who may accept

GitHub decides. The client draws the accept and decline buttons for anyone
signed in, and a commit from an account that is not a collaborator is refused
by GitHub, whose sentence is shown verbatim. That is the same rule the client
follows everywhere else: an identity decides whether a control is *drawn* and
never whether an operation is allowed. The audit trail is the commit log.

So the maintainer list is the repository's collaborator list. Adding a trainer
to the training team is `Settings > Collaborators`, and nothing in the client
needs to change.

---

## Registering the GitHub app

The client signs in with GitHub's **device flow**, which is the same shape as
its FAF login: the player is shown a short code, types it on github.com, and
the client receives a token it puts in the OS keyring. It never sees a
password.

That needs an OAuth app, which is five minutes and free:

1. **Settings > Developer settings > OAuth Apps > New OAuth App** on the
   `FAForeverRustClient` organisation.
2. Application name: something a player will recognise in the authorisation
   screen, e.g. `FAF Client (training catalogue)`. Homepage URL: this
   repository. The callback URL is not used by the device flow but the form
   requires one; the repository's URL is fine.
3. On the app's page, tick **Enable Device Flow**. Without it GitHub answers
   the device-code request with an error, and the sign-in button will report
   it.
4. Copy the **Client ID**. It is not a secret (the device flow has no client
   secret, which is exactly why it suits a desktop client that cannot keep
   one), so the shipped one lives in `infra/guides.rs` and nothing needs
   setting. `FAF_GUIDES_GITHUB_CLIENT_ID` overrides it for a fork or a test
   app.

The app in use is `FAForever RustClient (training catalogue)` on the
`FAForeverRustClient` organisation, client id `Ov23li9p0m7RMbNfLUgv`.

Leave **Expire user access tokens** off. With it on, GitHub issues tokens that
die after eight hours and expects the client to refresh them; the client does
not, so a maintainer would be asked to sign in again every working day. That is
a graceful failure rather than a broken one (a dead token is dropped and the
sign-in button comes back), but it is friction for no gain on a token scoped to
one public repository.

The token is requested with the `public_repo` scope, the narrowest one that can
commit to a public repository and comment on its issues. `repo` would
additionally hand over every private repository the account can see, which a
game client has no business holding.

A build with the client id emptied still lists the queue (open issues on a
public repository need no token) and says plainly that it was not configured
with a GitHub app, so accepting has to happen on GitHub.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FAF_TRAINING_CATALOGUE_URL` | none | Where the client reads `catalogue.json`. Unset, it uses the small catalogue shipped in the client. |
| `FAF_GUIDES_GITHUB_CLIENT_ID` | `Ov23li9p0m7RMbNfLUgv` | The OAuth app above. Set it empty to turn catalogue maintenance off in a build. |
| `FAF_GUIDES_REPO` | `FAForeverRustClient/guides` | The repository submissions and commits go to. |
| `FAF_GUIDES_API_BASE` | `https://api.github.com` | For a GitHub Enterprise host or a test double. |
| `FAF_GUIDES_OAUTH_BASE` | `https://github.com` | The same, for the device flow. |
