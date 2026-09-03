# Audit: the tournament feature against faf-tournaments

Taken 2026-08-18. Every number below is measured rather than estimated, and every claim was
checked against the tree. Compared against `D:\Projects\FAF\faf-tournaments`
(`server.js`, `lib/`, `public/app*.js`).

**This edition replaces the one from 2026-08-17.** That one's headline finding ("`viewer` does
not exist") was wrong. See section 2.

Findings that were fixed in the same session are marked **done** below rather than deleted:
what was found is as useful next time as what was left open. Section 13 lists what is still
outstanding.

---

## 1. The gates, actually run

| Gate | Before | After |
|---|---|---|
| `cargo fmt --all -- --check` | green | green |
| `cargo clippy` (with `-D warnings`) | green | green |
| `cargo test --workspace` | 1060 tests | **1074** tests |
| `pnpm run typecheck` | green | green |
| `pnpm run lint` | green | green |
| `pnpm test` (vitest) | 400 tests | **408** tests |
| `pnpm run architecture` | **RED, 16 violations** | **green** |
| `pnpm run i18n:check` | 35 untranslated, 1 of them in tournament code (a test file) | unchanged |

`pnpm run architecture` runs in CI (`.github/workflows/ci.yml:81`), so **CI was red on this
branch.** Both violations came out of the tournament work itself:

- `ui/src/store/reducer.conformance.test.ts: store imports feature code`, introduced by
  `12df788`. The price of the twin harness: the conformance test in the store was importing
  `tourneyPresentation.ts` out of the feature.
- 15 em-dash violations. Blame: `12df788` and `25daeab`.

The same pattern as the `cargo fmt` incident: everything else green, one gate red, nobody had
run it. **Done** (section 9.1).

**A second red gate, not from the tournament code.** Besides the scripts above, CI has two
embedded checks (`ci.yml:82` and `ci.yml:107`). The second, "No hardcoded colors outside
tokens.css", failed on `ui/src/design-system/modal.css:71` (`color: #fff` in `.btn-danger`),
introduced by `e12173e`. Outside the tournament brief, but it was holding the branch red.
Fixed here with a per-theme token, and then **superseded**: `e446295` on `develop` fixed the
same line with `var(--color-text)`, and that version was kept when the branches met.

---

## 2. Correcting the previous audit

### 2.1 `viewer` does exist

The last edition claimed `publicView` sends no `viewer` object, and concluded from that that
the whole tab was inert against the real server. **Wrong.**

`publicView(t)` (`server.js:917`) does not send it. But `GET /api/t/{id}` sets it
*afterwards*, on the finished document:

```js
const view = publicView(t);        // server.js:2487
...
view.viewer = {                    // server.js:2551
  admin, organizer, teamId, loggedIn, fafId, fafName,
  signedUpPlayerId, memberTeamId, invited, oauthEnabled, streamer, newsReadAt
};
```

Read `publicView` alone and you do not see it. The code documents this correctly now
(`protocol/tourney.rs:220`). No rebuild onto an identity derived from the `auth` slice is
needed, and it would have been the worse answer anyway: the same session check that fills
`viewer` authorises every write.

Of the twelve `viewer` fields we read six at the time of writing. `teamId` looked like the
most consequential gap; the check in section 10.1 disproved that. `caster` and `newsReadAt`
have since been added (sections 12.3 and 12.5).

### 2.2 What had actually been fixed since

| Finding | State |
|---|---|
| `search_players` sent `login=="X"*`, which RSQL rejects | **fixed** (`quote_prefix`), with a regression test that names the old bug |
| `ratingType` / `ratingDate` were being thrown away | **fixed**, both are read |
| `rejectionOf`, `newGames`, `isSubmittable` pinned only by hand-written cases | **fixed**, all three are in the conformance harness (`tourneyDraftRejections`, `tourneyReports`) |

That closes the "known remaining gap" noted in `[[tournament-backend-decision]]`.

---

## 3. Coverage, measured

| Level | Original | Ours | Share |
|---|---:|---:|---:|
| Tournament actions (`/api/t/{id}/{sub}`) | 79 | 40 | **51 %** |
| Response fields (top level, against the organiser response) | 85 | 46 | **54 %** |
| `viewer` fields | 12 | 6 | **50 %** |
| Website tabs | 11 | 10 | **91 %** |

Those were the numbers when the audit was taken. Sections 12 and 13 record what has moved
since; the coverage is far higher now, and the remaining gaps are named there rather than
recounted here.

### 3.1 Actions that were missing (43)

State after the third pass. `map_save`, `map_publish`, `map_delete`, `pool_publish` and
`pool_delete` had arrived by then and are no longer in this list:

`abandon`, `add_desc_image`, `add_organizer`, `cancel_invite`, `chat_delete`, `chat_mute`,
`claim_organizer`, `copy_maps`, `decline_invite`, `edit_date`, `edit_format`, `faf_lookup`,
`join_team`, `news_edit`, `news_read`, `org_create_team`, `organizer_visibility`, `pick`,
`pool_copy_sequence`, `qualifier_add`, `qualifier_remove`, `remove_desc_image`,
`remove_organizer`, `replace_player`, `restore`, `secrets`, `set_category`, `set_maps`,
`set_match_team`, `set_plan_round_bo`, `set_round_bo`, `set_series`, `set_team_name`,
`signup_team`, `undo_pick`, `veto_action`, `veto_setab`, `veto_undo`

Measured on 2026-08-18, and the arithmetic adds up:

| | Count |
|---|---:|
| Implemented as `POST` | 38 |
| Implemented as `GET` (`chat_rooms`, `chat_read`) | 2 |
| Deliberately out (`faf_lookup`, `join_team`, `set_team_name`, `signup_team`, `set_maps`, `report_submit`) | 6 |
| **Real gap** | **33** |
| Total | 79 |

The reasoning for each exception lives in `tourney-features.md`.

### 3.2 Fields the server sends and we do not read (37)

The list now lives as `IGNORED` in `crates/faf-domain/tests/recorded_tourney.rs` and is
checked against the recorded response: when the service grows a field the test fails, and
"read it or knowingly ignore it" gets decided rather than overlooked.

The heaviest of them at the time: `plan` (best-of per round), `ffaCfg` (the whole free-for-all
configuration), `importedStandings`, `qualifiers`/`seriesId` (series), `streams`,
`lobbyOptions`. All but `plan`, `importedStandings`, `streams` and `lobbyOptions` have since
been read; section 12.4 has the current count.

No longer in it: `published` (section 5), and `imported` and `teams[].out` (section 10.3).

### 3.3 Tabs that were missing

The website has eleven: `overview`, `news`, `chat`, `players`, `teams`, `bracket`, `maps`,
`vetoes`, `standings`, `admin`, `log`. When the audit was taken we had eight sections; what
was missing was **maps** (the map database, not the pool assignment), **vetoes**,
**standings** and **log**.

**Standings, the map database and the log were built on 2026-08-18** (sections 10.3, 11.3 and
11.4), **vetoes** on the same day (section 12.1). Every website tab now has a counterpart
except the Hall of Fame, which is not one of the eleven.

Size in the original: `drawMaps` 180 lines, `drawVetoes` 117, `drawStandings` 98, `drawTlog` 18.

---

## 4. Dead code

### 4.1 With no caller at all

| Where | What | State |
|---|---|---|
| `state/tourney.rs` | `Tourney::may_rename`, **no caller in Rust**. Only the doc comment of its TS twin mentions it | **done**: pinned in the conformance harness, which gives the Rust half a caller and the rule a bracket |
| `tourneyPresentation.ts` | `hasBracket`, exported, imported nowhere | **done**: `mayReport` uses it now |
| `BracketView.tsx` | `Side`, an exported type used only locally | **done**: `export` removed |
| `MapPoolPanel.tsx` | `roundKeys`, exported, used only locally | **done**: `export` removed |

`may_rename` was exactly the pattern from `[[cleanup-before-features]]`: a rule written in
Rust, written again in TypeScript, and the Rust half left without a caller.

### 4.2 Unreachable command surface

Five `TourneyCommand` variants existed in full (command, port method, real implementation,
fake, service arm, integration test) and were **never sent** by the interface:

| Command | Consequence | State |
|---|---|---|
| `Publish` | **A functional gap**, see section 5 | **done**, wired up |
| `SavePool` | Map pools could be assigned but not created or edited | **done** (section 11.4), wired into the pool editor |
| `SetDivision` | Divisions could be split, but individual teams could not be moved between them | **done**, wired up |
| `SubmitReport` | The player reporting path. Deliberately not offered, but the code was still there | **done**, deleted |
| `LoadDetail` | Redundant: `Select` calls `load_detail` itself | **done**, deleted |

---

## 5. The concrete gap: created tournaments were invisible

`POST /api/tournaments` creates with `published: false`. The list (`server.js:2227`) shows
unpublished tournaments to their organiser alone.

The client could create. It had **no publish button**. A tournament created in the client was
therefore a draft nobody else could see, and the client could not release it.

`Publish` was complete all the way down to the fake. Exactly one button and one prop
forwarding were missing. On top of that `published` was not parsed, so the tab could not even
show the state.

**Done.** `published` and `publishAt` in the model and the codec, `Tourney::may_publish` with a
TS twin and a conformance case, its own section in the manage panel with explanatory text, the
fake reproduces it (`create` makes an unpublished event, `publish` releases it), and an
integration test walks the whole path.

Evidence from the recorded instance: all three tournaments in the bundled `db.json` are
unpublished, and `GET /api/tournaments` there answers plainly `[]`.

---

## 6. Twin drift

`BracketView.tsx:188` carried a twin of `Tourney::may_report`:

```ts
const mayReport =
  event.viewer.organiser &&
  entry.bracket !== "freeForAll" &&
  entry.team1 !== null &&
  entry.team2 !== null;
```

The Rust version (`state/tourney.rs:994`) additionally requires `self.status.has_bracket()`.
**The twin had drifted.** And it sat in a `.tsx`, which is precisely what the pinning rule
forbids: the harness cannot import a component module, so nothing could hold that twin in
place.

**Done.** Every twin was moved to `ui/src/shared/tourneyRules.ts`, where the harness can reach
them: `check-architecture.mjs` forbids `store/` from importing `features/`, so a twin inside
the feature was unpinnable by construction. `galacticWarActions` and `playerNotes` already
live there for the same reason. `tourneyPresentation.ts` keeps presentation only.

`mayReport` lives there now, has its `hasBracket` half back, and is pinned. Counter-checked:
reintroduce the drift and the harness fails with the diff on `reportableMatchIds`.

Only `profileOf` was left unpinned, and section 11.1 closed that too.

---

## 7. Legacy

| Where | What was out of date | State |
|---|---|---|
| `docs/faf-tournaments-api.md` | Disproved on at least three points by the previous audit, and left standing unchanged | **deleted** |
| `docs/tourney-migration.md` | Pointed at that very file first. Claimed "The client is for participants, not administrators" and "Setting a tournament up stays on the website". Both withdrawn; the code has `TournamentForm` and `ManagePanel` | **corrected**, points here now |
| `TournamentsView.tsx`, header | "Creating a tournament and configuring its format stay on the website", above code that creates and configures | **corrected** |
| `TournamentDetailPane.tsx`, header | "Manage is last and is a link, because setting an event up stays on the website". Manage is a full section | **corrected** |
| `EntrantAdmin.tsx:100` | "`publicView` does not send the rating type", exactly the false claim from the deleted document. `ratingType` arrives with every response | **corrected** |
| `infra/tourney.rs`, header | Pointed at the deleted document as the place that tracks the server | **corrected** |
| `docs/tourney-features.md` | Stale in **both** directions, see below | **corrected** |

`tourney-features.md` reported **Done** for `publish`, `pool_save`, `set_division` and
`report_submit`, all four of which were unreachable from the interface (section 4.2). And it
reported **Todo** for `set_captain`, `move_player` and `edit_player`, which had shipped with
`12df788` and `25daeab`. The file now carries the rule that prevents this at the top:
**Done means reachable, not implemented.**

---

## 8. Done: a real server response now lives in the repo

The most important point of the previous audit is **closed**.
`crates/faf-domain/tests/recorded/tourney-detail.json` is a real `GET /api/t/{id}`, recorded
from `faf-tournaments` started locally on a scratch `DATA_DIR`. The live instance was not
touched.

The tournament in it was built through the service's own endpoints, so that teams, bracket and
pool are its output rather than a hand-written shape: create, publish, four teams of two,
`form_teams`, `start_bracket`, four maps, a Bo3 pool with a ban/pick order, one message.
`crates/faf-domain/tests/recorded_tourney.rs` checks the codec against it, in eight tests.

### 8.1 What the real response exposed immediately

| Finding | State |
|---|---|
| **A map pool's ban/pick order was being thrown away silently.** `sequence` is an array of `{action, team}` objects (`lib/match.js::cleanSequence`); `parse_pool` read it with `string_list`, which discards objects. Every order was empty, and nothing failed | **fixed**: `PoolStep`/`PoolAction`/`PoolSide`, held in the test |
| `viewer` is present in the real response | confirmed, see section 2.1 |
| The map preview is called `image`, not `imageUrl` (an open question from memory) | **answered**, `parse_map` already had it right |
| A match sends `bo` and `hcap`, not `bestOf`/`handicap` | already read correctly, now held in place |
| Bracket sides are called `wb`/`lb`/`gf` | `BracketSide::from_wire` already had it right, now held in place |
| `news_post` wants `body`, `phase` wants `action` | both checked against the running service, both correct here |
| All three tournaments in the bundled `db.json` are **unpublished**, and `GET /api/tournaments` answers `[]` | practical evidence for section 5 |

### 8.2 The tripwire rule

`every_field_the_service_sends_is_either_read_or_knowingly_ignored` checks both directions: a
new field on the service breaks the test, and a field that stops arriving must not stay listed
as "knowingly ignored". It corrected two entries on its first run. Section 12.4 adds a third
direction and explains why the first two were not enough.

---

## 9. What the first session cleared

Ordered by blocking effect, paying down decay first, per `[[cleanup-before-features]]`.

### 9.1 CI green again

15 em dashes replaced, in source and in the translation catalogue. For the conformance import
there were two ways out: move the twins downward, or widen the rule with an exception. The
first is correct and was already house practice, just not for this feature:
`shared/galacticWarActions.ts` and `shared/playerNotes.ts` sit there for the same reason.

Result: **`ui/src/shared/tourneyRules.ts`** now holds all 24 twins, and
`tourneyPresentation.ts` keeps presentation only. Fifteen imports rewritten.

### 9.2 The twin rule made precise

It used to read "pinned twins live in `tourneyPresentation.ts`, never in a `.tsx`". That was
too weak: `tourneyPresentation.ts` itself sits under `features/`, and the harness may not
import from there. The rule now reads: **pinned twins live under `ui/src/shared/`.**

### 9.3 Three rules newly pinned

| Rule | Why it needed it |
|---|---|
| `may_report` | Had drifted: the TS twin had lost its `has_bracket` half |
| `may_rename` | The Rust half had no caller, the TS half ran alone |
| `may_publish` | New, and the most consequential visibility rule in the tab |

Four new cases in the fixture, among them the decisive pair "the same state, once before and
once after the draw". Counter-checked: reintroduce the `may_report` drift and the harness
fails.

### 9.4 The publication gap closed

Section 5. Model, codec, rule with twin and conformance case, fake, interface, translations,
integration test.

### 9.5 A real server response recorded

Section 8. It immediately exposed a silent data loss (the pool order) and answered the open
question about the preview field's name.

### 9.6 Legacy cleaned up

Section 7. One document deleted, five places corrected.

---

## 10. Second pass, 2026-08-18

### 10.1 `viewer.teamId` is not needed after all

Checked and rejected. `viewer.teamId` is the team you captain, worked out through
`players[].captainId` and the FAF identity. We already derive exactly that
(`team.captainId === viewer.signedUpPlayerId`, in `mayRename` and `TeamsPanel`), and the server
authorises `rename_team` and `disband_team` through `actingPlayer`, which itself resolves the
session first. The two paths coincide; a second field would be a second source for the same
answer.

The only exception, and irrelevant to us: accessed through a captain token, `viewer.teamId`
would be set and `signedUpPlayerId` empty. The client uses no tokens.

### 10.2 The unreachable commands decided

| Command | Decision |
|---|---|
| `SubmitReport` | **deleted**, along with the port method, real and fake implementations, service arm, action variant and tests. Only the organiser records a result |
| `LoadDetail` | **deleted**. `Select` calls `load_detail` itself |
| `SetDivision` | **wired up**: a picker per team in the team admin, shown once the field is split |
| `SavePool` | **done** with the map database, see 11.4 |

`AnswerReport` stays deliberately: answering a score reported on the website is not the same
act as recording one, and a client that showed the open report without being able to answer it
would be worse than one that never showed it. The fake now seeds such a report rather than
letting one be written.

### 10.3 Standings built

The largest missing tab. Three tables behind one heading:

| Mode | Built from |
|---|---|
| **Swiss** | Wins, losses and game difference over the `sw` matches. A bye counts as a win with one game |
| **Elimination** | How far the run got, from `teams[].out`. Teams knocked out equally deep share a place: 1, 2, 3, 3 |
| **Imported** | The final table the import brought with it, from `finalRank` |

New in the model for this: `TeamExit` (`teams[].out`) and `imported`. Both arrived with every
response and were being thrown away.

**Not included at the time: free-for-all points.** The table is summed from a per-match
`points` object the client did not model, and an invented order would be worse than none. That
was closed in section 12.1.

The rule lives in `Tourney::standings`, has a twin in `shared/tourneyRules.ts` and five
conformance cases. That matters more than usual here: **the service sends no table at all**,
the website works it out in the browser, and so do we. Three implementations of the same rule,
and nothing external would notice them drifting apart.

---

## 11. Third pass, 2026-08-18

### 11.1 The last unpinned twin

`profileOf` is in the harness now, with three cases: the loaded account, the hand-added
entrant without an account, and the id the profile list does not know yet. With that, **every**
tournament twin is pinned.

### 11.2 A second recording, as the organiser

`crates/faf-domain/tests/recorded/tourney-detail-organiser.json`: the same tournament again
with `?token=<adminToken>`. **85 fields instead of 79.** The six extra are `tlog`,
`organizers`, `chatMutes`, `invites`, `createdByName` and `chatPingCount`.

`organizers`, `invites` and `chatMutes` had to be written into the scratch database by hand,
because all three need a real FAF login the local service cannot provide. The service rendered
them itself, so the *delivered* shape is its own.

Two findings from it:

| Finding | Consequence |
|---|---|
| `chatMutes[].fafId` arrives as a **string**, where everywhere else it is a number. The service builds the list from `Object.keys` | Read strictly, every mute would be dropped. The tolerant `int` reader catches it, and it is now held in place |
| `organizersPublic` leaves out hidden organisers, `organizers` does not | Two lists with different meanings, and both are read |

The tripwire now runs over both recordings merged.

### 11.3 Audit log built

`tlog` is `{at, by, text}`, newest first, at most 300 lines, and the service sends it to nobody
else. Its own section, organiser-only, and shown only when lines actually arrived: an empty one
would be indistinguishable from "nothing happened here".

`at` is milliseconds. A test holds the division in place, or the whole log dates to 1970 and
sorts into nonsense.

### 11.4 Map database built

Three steps in the order they have to happen:

| Step | What |
|---|---|
| `MapDbPanel` | Add, edit, publish, hide and delete maps |
| `PoolEditor` | Group maps into a pool, with a series length and a ban/pick order |
| `MapPoolPanel` | Bind a pool to a round (this already existed) |

New in the model: `description` and `published` per map, `published`/`publishAt` per pool,
`MapDraft`, `PoolDraft::sequence`, and `PoolDraft::rejection` with its twin and seven
conformance cases.

The service's counting rules are the reason for the twin: every map but one is consumed by a
step, and every pick is a game. So a Bo3 wants four maps and three steps, two of them picks.
The service refuses anything else and names the numbers only afterwards.

Two rules the fake now reproduces, because players see their effect: deleting a map clears it
out of every pool, and publishing a pool publishes its maps with it.

**Not included:** `copy_maps` and `pool_copy_sequence` (conveniences for reusing another
tournament's work), `set_maps` (the superseded per-round list), and map images, which are
uploaded as data URLs.

---

## 12. Fourth pass, 2026-08-18: the rest

The five points that stood here as open have been worked through. What became of them, and
what was decided rather than built.

### 12.1 Vetoes, free-for-all and the draft

| What | Where |
|---|---|
| **Vetoes** | `MatchVeto`, `VetoChoice`, `VetoDecider`, `VetoConfig`, `VetoMode`, `VetoTurn`. `veto_action`, `veto_setab`, `veto_undo`. The fake walks the order itself, with `advance_veto` as a twin of `lib/match.js::vetoAdvance`, so the run is playable offline |
| **Free-for-all** | `FfaConfig`, `FfaMode`, `FfaReport`, `TeamPoints`. `report_ffa`. The points table in the standings falls out as a by-product, exactly as predicted here |
| **Draft** | `Draft`, `DraftPick`. `pick`, `undo_pick`, `phase` `set_captains`/`start_draft` |

Two findings from that work, both naming errors on our side rather than arithmetic ones:

- A free-for-all conformance case was called "the last lobby". The server checks `m.isFinal`,
  not "last". The label claimed something the code did not do.
- `TourneyStatus::Draft` was documented here as "announced, not yet open". `lib/teams.js:53`
  sets `status = 'draft'` when the captains draft starts. The comment was wrong, the code was
  not.

### 12.2 Series and qualification

Two mechanisms that sound like one, and are pulled apart in the code because they are:

| | What it is |
|---|---|
| **Series** | A label. Editions are fully independent tournaments: no shared bracket, no qualification between them, no fixed cadence. That is why it hangs off `GET /api/series` and not off any one tournament |
| **Qualifier** | A real link. When the child finishes, its best entrants are *invited* into the parent. They still have to accept, so qualifying is not a signup |

New in the model: `TourneySeries`, `SeriesDetail`, `SeriesEdition`, `SeriesDraft`,
`SeriesColour`, `Qualifier`, `QualifierRule`, `QualifierKind`, `FeedsInto`, and on `Tourney`
the five fields `seriesId`, `seriesName`, `seriesColour`, `qualifiers`, `feedsInto`, all of
which had been thrown away.

The twin this needed is `Tourney::qualifier_rejection`. Three of its four answers mirror a
refusal the service makes. The fourth does **not**, and that is the reason the twin exists: a
points rule against an elimination bracket is *accepted* and then qualifies nobody, silently.
The organiser finds out when the invitations they were waiting for never arrive. Seven
conformance cases, counter-checked.

The service's fourth check, "that tournament already draws its qualifiers from this one", needs
the *candidate's* own link list, which a list row does not carry. It stays with the service and
comes back as a refusal; an integration test holds it in place that the refusal really arrives.

The fake gained a **finished** tournament (`e7f7f`) for this. Without one the whole flow ends
at "linked, waiting": a qualifier link is applied when its child has finished. The runner-up in
it was added by hand and has no FAF account, which is the case that counts: they qualify and
cannot be invited. The service reports that rather than swallowing it, and the interface has to
show it.

### 12.3 The small actions, and what was deliberately left out

Built:

| Action | What was not obvious about it |
|---|---|
| `chat_mute`, `chat_delete` | Moderation sits on the post, not in a panel of its own: that is where the organiser is when they decide. For that `ChatPost` had to read `fafId`, which we were discarding: `chat_mute` addresses an account, and the name beside a post is free text with nothing to resolve it against. And `chatMutedMe` is read now, so a silenced account learns it **before** typing |
| `add_organizer`, `organizer_visibility` | Two lists with different meanings, see 11.2. Hiding changes the credit, not the rights |
| `edit_format` | Two locks, one step apart: the whole format closes at the draw, the team setup one step earlier with signups. The service refuses the four structural keys **on presence**, not on change: resending an unchanged team size turns a harmless bracket edit into "Reopen signups to change the team setup". So the service arm decides per write whether to send them |
| `abandon` | Not the same as archiving. An abandoned tournament stays visible and says so; an empty bracket with no explanation reads as broken |
| `news_edit`, `news_read` | The read marker is the service's, not local: the badge clears on every device rather than once per machine |
| `add_caster`, `remove_caster` | The role that replaced the caster link. The link carried a token in a URL, which the client had nowhere to put. `viewer.caster` and `casters` are read; the chat room list widens on its own, because `chatRoomsFor` gives a caster every room on the strength of their session |

Deliberately out, with reasons:

| Action | Why not |
|---|---|
| `edit_date` | `edit_info` already writes the name and all three dates. A second path to the same four fields is exactly the pattern from section 4.2. Its only extra fields are `minTeams`/`maxTeams` |
| `remove_organizer`, `restore`, `set_category` | All three are site-admin only, and **nothing the service sends says whether this account is a site admin**: `viewer.admin` is the holder of an admin *token*. The button would answer "Site admin only" to every ordinary organiser, which reads as broken rather than as locked |
| `claim_organizer` | Authorised through the token in the organiser link, that is, through a URL pasted into a browser. The client has nowhere to paste one |
| `secrets` | Three tokens whose only purpose is a URL for somebody else. The website already does that, with copy buttons and the wording that goes with them |

### 12.4 The tripwire gained a third direction

`every_field_the_service_sends_is_either_read_or_knowingly_ignored` now also checks: **a field
listed as "knowingly ignored" that is in fact read.** The first direction cannot find that,
because it filters the ignored names out first; the list quietly becomes a claim nobody tests.
On its first run three such entries fell out: `ffaCfg`, `draftOrder` and `pendingCaptains` were
listed as gaps and had been read for a while.

All three directions now match only a read rooted at the response document (`document, "x"` or
`document.get("x")`), over the codec alone rather than its test module. Without both it
misfires: `ffaCfg.rounds` is a different field of the same name one level down, and `"seeding"`
in `create_body` is written, not read. Five such false alarms came out of the first draft, and
the weaker answer would have been an exception list.

That precision then caught a real one. `signupMode` is sent by the service, was never read,
and was **not** on the ignore list either: the old check counted it as covered because the
string appears in `create_body`. The edit form therefore guessed at it and guessed `"open"`,
so correcting a typo in an invite-only tournament's name reopened it to everyone. Two more of
the same shape are recorded in `tourney-features.md` section 3.1.

The ignore list fell from **41 to 31** entries in this pass.

### 12.5 The chat, checked against what the tournament team asked for

Checked against two requirements the tournament team stated directly, plus the website's own
room list.

| Asked for | Found |
|---|---|
| "Chats only get generated when the match is set, as in both teams are known" | **Already right.** `chatRoomsFor` decides it and the client renders what it is sent. Pinned with a test. The offline fake was wrong: it made a room for BYE matches and used the bare match id where the service uses `match:{id}` |
| "Chats get archived and no longer shown, or shown under Completed which you can expand and minimize, when a Match is done. Otherwise you will see too many, which was an issue at first and made it confusing" | **Was missing.** The codec read `id`, `label` and `unread` and dropped the rest, so a finished match's room stayed in the live list forever |
| "Chats are only shown to participants of the tourney" | **Already right**, service-side |
| The caster link | **Now a role**, see 12.3 |
| Chats lock some days after the event | **Already right.** `chatLocked` is read, the composer closes and says why. Two days after the finish stamp |

Reading `done` brought back two more fields that had gone with it: `mention` (this account was
named with `@` here, which replaces the unread count rather than sitting beside it) and `ping`
(somebody typed `!organizer` and no organiser has read it).

**And one nobody had raised: the chat could send but not receive.** There was no polling
anywhere and the service has no push of any kind, so a message from anyone else never arrived
until the reader switched rooms and back. Writing worked, which is what had been tested. The
open room and the room list are re-read every five seconds now, silently.

### 12.6 Drawing the bracket asks the question the website asks

The website's Generate button opens a dialog and sends the best-of plan as a `config` object
with `phase`. The client sent `{action: "start_bracket"}` and nothing else, so the service fell
back to its stored defaults every time and the organiser never got a say.

The shapes differ per format, all read off the handler: single takes `{rounds: [...]}`, double
takes `{wb, lb, gf, lbHandicap}` with `2R-2` losers rounds, swiss takes
`{rounds, bo, final, finalBo, fast}`, and a free-for-all takes `{}` because it is drawn from
`ffaCfg`.

This also corrects a claim this feature's own documentation had been repeating: that the
best-of plan "stays on the website". The timing half was right, the conclusion was not. It is
not a separate website editor, it is one question asked at the one moment the answer is
knowable, once teams exist and the round count follows from them.

The service pads or trims the round list to the bracket's real length, so a plan with too few
rows would silently lose a round's setting rather than fail. Checked before sending, with six
conformance cases.

---

## 13. What is still open

No longer a list of missing mechanisms, but a list of pages and conveniences:

1. **Hall of Fame** (`GET /api/halloffame`): the only website page with no counterpart.
2. **A series page**: the list and its editions are loaded and held in the slice, but have no
   page of their own. The *organiser* half (filing, creating, qualifiers) is built.
3. **Description images** (`add_desc_image`, `remove_desc_image`) and map images: both are
   uploaded as data URLs.
4. **Reusing another tournament's work**: `copy_maps`, `pool_copy_sequence`.
5. **`set_match_team`**, **`replace_player`**, **`cancel_invite`**, **`org_create_team`**,
   **`decline_invite`**: individual organiser handles with no common theme.
6. **The per-round best-of plan outside the draw** (`set_plan_round_bo`, `set_round_bo`): the
   draw itself now asks for it (12.6), but editing it afterwards is the website's.
7. **The chat's remaining presentation**: the organiser callout with Discord handles, the
   pre-start note, and a button for `!organizer` (typing it works).
8. The client-only wins in `tourney-features.md` section 4: notifications, replay links, map
   pool prefill in the host dialog.

`docs/tourney-features.md` carries the detail and was brought up to date on 2026-08-18.
