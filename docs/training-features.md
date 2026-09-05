# Training tab: what is built, and what is not

The Tutorials tab is now **Training**. The rename is the smaller half of the
change: the tab used to be a list of FAF's guided lessons, and it is now a hub
whose job is discovery and routing.

The premise, and it is worth stating because it decides everything below: FAF
does not lack training material. It lacks a place where a player finds out that
the material exists, where it is, and which of it applies to them. Videos are
spread over a dozen YouTube channels, guides over the wiki and the forum, and
the human half (replay reviews, trainers) lives in Discord behind a channel you
have to know the name of. The client is the only part of FAF that already knows
who the reader is, which is the missing ingredient.

Discord is not treated as a competitor. The client is discovery and access; the
community is interaction and human training. The hero routes *to* it.

---

## Built

### The hub (`training.section.hub`)

- **Hero.** Two offers: request a replay review, and join the training
  community. The Discord button is drawn only when the catalogue names an
  invite (see [Configuration](#configuration)); an empty invite hides the
  button rather than sending anyone to a guess.
- **What this is based on.** The rating, modes and maps the recommendations were
  computed from, shown rather than implied. A rail nobody can account for reads
  as noise.
- **Recommended for you.** Up to six entries, ranked in Rust
  (`faf_domain::state::training::recommend`) and delivered to the UI as an
  ordered list of ids. Weights: a stated rating band that covers the player
  beats a map they have been playing, which beats a mode, which beats a
  faction; material written for a player several hundred points away scores
  negative and is not recommended at all. Community destinations never fill a
  rail slot, because the hero already offers them.
- **Learn the basics.** Four topic cards (economy, build orders, micro, map
  control) that open the library filtered to that topic.
- **Contribute.** Opens the submission form.

### The library (`training.section.library`)

The whole catalogue with filters for free text, level, type, topic, game mode,
map, and "for my rating". Filtering runs locally
(`ui/src/shared/trainingRules.ts`) because it runs on every keystroke; the
rules are twins of the Rust ones and are pinned by the `trainingFilters` cases
in the conformance fixture.

Two filter behaviours are deliberate and easy to mistake for bugs:

- an entry that names **no** map matches every map filter, and the same for
  game modes. Most material is about the game rather than about one map, and
  the alternative is a map filter that empties the library;
- a level implies a rating band when an entry states no numbers, and stated
  numbers win over the level they contradict.

### The lessons (`training.section.lessons`)

FAF's own guided lessons, unchanged: the `tutorials` slice still owns the
tutorial API, the `tutorials` featured-mod patching and the offline launch. The
existing view is rendered as a section of the new tab rather than reimplemented.

### Replay review requests

Openable from three places: the hero, a resource's detail pane, and the replay
detail panel in the Replays tab. The last one is the point of the feature: the
client already knows the replay id and its link, the map, the mode, when it was
played, and this account's own faction and rating **in that game** (read from
the replay header, not from the current account rating). So the form opens with
only the two questions left that nobody else can answer.

The request is opened by *reference* (`openReview { replayUid, localPath }`) and
the service reads the rest out of state. A caller therefore cannot prefill the
form with something the client does not actually know.

Both forms own their draft locally while it is being typed and hand it over
once, on `composeReview { draft }`. A command per keystroke would put an IPC
round trip between a key and the character appearing, which for a controlled
text field is how typed characters get dropped; it would also recompute the
library filter on every character. The state still ends up agreeing with the
post, because the service records the draft through the reducer before
composing from the post-reduce state.

### The training team (its own tab)

Its own section rather than a strip on the hub: "who can help me" is a question
somebody arrives with, not something they should have to scroll past the
recommendations to find. Tiles, from the catalogue's `trainers` block: name,
role, the topics and modes they coach, the rating range, languages, a Discord
handle and whether they are currently taking students. A trainer who has stepped back stays listed and
marked, because "this person coaches, just not right now" is more useful than a
name that vanished.

The one thing the client adds over the same list posted on the forum is
`fafId`: with it the tile opens the player card, so their real rating, avatar
and history resolve, and they can be messaged from the client. Same reason a
tournament entrant carries one.

Deliberately a list and not a matching service. Anything more (availability,
scheduling, a request queue) needs every trainer to keep a profile current,
which is the maintenance burden the rest of this tab exists to avoid.

### The submission queue, and accepting

Built, and it writes. The catalogue lives in `FAForeverRustClient/guides`, so a
submission is a GitHub issue and a verdict is a commit; the format of both is
[training-catalogue.md](training-catalogue.md).

- **The queue is its own tab, and a closed one.** A player who cannot act on it
  has no use for a list of other people's unreviewed guides, so the tab explains
  what it is and how to be let in. The underlying issues are public either way;
  this is about whose screen they belong on. Four different reasons to be locked
  out get four different sentences, because telling a signed-in
  non-collaborator to sign in would send them looking in the wrong place.
- **Signing in is GitHub's device flow.** A short code, typed on github.com.
  The client never sees a password and stores only a token, in the OS keyring
  beside the FAF one, requested with `public_repo`: the narrowest scope that
  can commit to a public repository.
- **Accepting is one press.** The submission is already in the catalogue's own
  terms, because the client wrote the form it came in on, so accepting is a copy
  rather than a rewrite. It commits the guide file when the author wrote one, adds the entry to `catalogue.json`, comments where it landed and closes
  the issue. Guarded by the file's content hash, so two trainers working at
  once get a refusal and a retry rather than a lost commit.
- **Declining takes a reason** from a closed set, plus an optional note, and
  both go into the issue where the author reads them.

**GitHub enforces the permission.** The buttons appear for anyone signed in,
and a commit from a non-collaborator is refused by GitHub, whose sentence is
shown verbatim. That is the client's standing rule: an identity decides whether
a control is drawn, never whether an operation is allowed. It also means the
maintainer list is the repository's collaborator list, and adding a trainer
needs no client change.

Until an OAuth client id is configured the queue is still listed and the tab
says why accepting is not offered.

### Lessons: the tab is empty on purpose

A lesson here means something the client can *start*: it patches the `tutorials`
featured mod, fetches the map and opens an offline game. That path is finished
and tested, and it launches nothing today, because nobody has authored a
scenario for it. FAF's tutorial API carries links to videos and wiki pages
rather than playable maps; those are library resources like any other and reach
the reader that way.

So the tab stays and says so. "Coming" is information; a tab that quietly
disappears is not, and one listing links under the word "playable" is worse
than either. It fills in by itself the day a scenario exists: the count and the
pane both key off whether any entry is actually launchable.

What a scenario would be is a design question, not a client one. The useful
shape is closer to a chess puzzle than to a co-op mission: a fixed starting
position, one thing to get right, a win condition that fires when they do.
That is a small amount of Lua next to a scripted campaign map, but it is still
authoring work, and the bottleneck is a person who knows both the map editor
and what a player at a given rating gets wrong. Nothing in the client needs to
change when that person appears.

### Submissions

A form whose point is the tag block: level, rating band, modes, maps, factions,
topics. A trainer's bottleneck is not writing guides, it is that everything
arriving from the community has to be categorised by hand before anyone can
find it. Asking the author once, while they still have the answers in mind, is
the difference between a submission a curator can accept in one step and one
that needs a conversation first.

Includes a small dependency-free Markdown editor with a toolbar and preview
(`features/training/markdown.tsx`). It builds React nodes and never constructs
HTML, which is the same posture the rest of the client takes towards markup it
did not write.

### How both forms leave the client

**The client composes; the player posts.** Both paths end in a post shown in
full before it goes anywhere.

A **guide submission** goes to the catalogue's repository as an issue: sent
directly when the author is signed in to GitHub, and otherwise through a
prefilled new-issue link, which produces a byte-identical issue so the queue can
accept either in one step. A **replay review request** goes to the training Discord, which is where FAF
actually answers them. Discord cannot be handed a prefilled message, so there
the client's job ends at writing the request: copying is the action and the
link only opens the server. The value was never the paste, it is not having to
find the channel and remember what the pinned template asks for.

`forum.faforever.com` runs NodeBB, whose composer reads `cid`, `title` and
`body` off the query string (`nodebb-plugin-composer-default`, its
`filter:composer.build` hook), so a prefilled post needs no API access and no
credentials. GitHub's new-issue form takes `title`, `body` and `labels` the
same way.

This is a decision, not a limitation to be fixed later. Posting on someone's
behalf would need their forum session, and a request written by a bot in a
human's name is exactly what a training community does not want. What the
client removes is the part that actually stops people: find the channel, find
the template, dig the replay id out of a file name.

---

## The catalogue

Three sources, merged in the service:

1. **FAF's tutorial API** (`/data/tutorialCategory`), already modelled by the
   `tutorials` slice. It carries titles, briefings, categories and, for the
   video and written-guide categories, links. It carries **none** of the
   metadata this hub filters on, so tags are inferred from the author's own
   words by a small keyword table (`derive_topics`, `derive_level`). That is a
   fallback so an untagged catalogue is still filterable on the day it loads,
   not a substitute for tags.
2. **A remote manifest**, a plain JSON document at a configured URL, held in
   its own Git repository. Format and repository layout:
   [training-catalogue.md](training-catalogue.md). Every
   field is optional, unknown fields are ignored, and an entry with no id or no
   title is dropped rather than sinking the document: a manifest is edited by
   hand and a strict parser would turn a typo into an empty tab. A manifest
   entry naming a `tutorialId` **replaces** the derived lesson entry wholesale
   rather than merging with it, because an entry whose tags come from a curator
   and whose level comes from a keyword table is not something anyone can
   reason about.
3. **The seed** shipped at `crates/faf-app/src/infra/training_catalogue.json`.
   Deliberately tiny, and it lists only destinations this repository already
   relies on. A guessed URL in a shipped client is worse than a short
   catalogue, and FAF's hosts cannot be probed from a development machine
   (Cloudflare answers 403 to everything).

The tab says which of the two it is showing (`Built-in catalogue` /
`Community catalogue`), because a client on the seed shows a fraction of what a
published manifest carries, and looking thin for no stated reason is worse than
saying so.

### Personalisation, without fetching anything for it

`profile_from_state` folds a profile out of state other tabs already load:

- the account name and, when the matchmaker profile has been opened, its
  per-leaderboard ratings (preferring `global`, then `ladder_1v1`, then the
  leaderboard with the most games);
- the newest 40 local replays, which are this player's own recent games and
  carry the map, the mod, their faction and their displayed rating in each
  file's header. Only rows matching this account shape the profile: reading the
  opponent's faction and rating would describe the wrong player.

The live matchmaker rating wins over what a replay recorded. If neither is
available the profile says so, and the hub says what it is missing.

One guard worth knowing about: the player card is a single slot and clicking a
name in chat fills it with a stranger, so the matchmaker profile is only read
when its `playerId` is this account's.

---

## Configuration

| Variable | Meaning |
| --- | --- |
| `FAF_TRAINING_CATALOGUE_URL` | The training manifest. Empty (the default) means the seed is used; pointing at a URL nobody has published would make every load wait for a request certain to fail. |

Two values live in the catalogue's `links` block rather than in code, because
neither should need a client release to change:

- `discordUrl`: the training community's invite, `https://discord.gg/By9tNUAq8B`
  in the seed. A manifest may replace it and inherits the seed's when it says
  nothing; an empty value hides the button rather than sending anyone to a
  guess.
- `trainers`: the training team's tiles. Empty in the seed on purpose, because
  who coaches and whether they still coach is theirs to state.
- `replayReviewCategory` / `contributeCategory`: NodeBB category ids for the
  prefilled composer. The seed uses category 4 ("I need help"), which is the
  right destination when no dedicated one is configured. Without a category id
  the post is still composed and can still be copied; only the prefilled link
  is missing.

---

## Not built

### Build orders in the matchmaker and the map-selection screen

Waiting on the catalogue, by decision: this lands once the guides (build orders
included) are actually published somewhere the client reads. The model is
already there (a build order carries its maps and modes), so the missing piece
is a link from the lobby and matchmaker surfaces into a filtered library query.

### Automatic mistake detection from a replay

**Ruled out**, not deferred. Recognising a mistake in a replay's command stream
is a different order of problem from anything else here, and the tab does not
need it: pointing a player at material for their rating and their maps is the
job, and a wrong automated diagnosis would be worse than none.

### Translations

English and German are complete. The other four catalogues have the tab's name
translated and fall back to English for the rest, which is how partial
catalogues are meant to work here (`pnpm i18n:coverage` measures it).
