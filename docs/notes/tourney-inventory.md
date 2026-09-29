# The tournament tab against faf-tournaments: inventory

Taken 2026-09-28, as the starting point for making the client a full
replacement for the tournament website.

- **Reference**: `FAForeverRustClient/faf-tournaments` at `d2cac09`
  (2026-09-28 16:09 +0200). It is the source of truth for behaviour.
- **Client**: `develop` at `c568b94`.
- **Supersedes** `tourney-features.md` and the open items of `tourney-audit.md`.
  Both were written on 2026-08-19 against a local copy of the website that no
  longer exists. Since that day the website has grown by **7,782 lines and lost
  680** (`server.js` +2,446, `lib/swiss.js` +640, `app.results.js` +1,109,
  `app.bracket.js` +960, two new modules `lib/picks.js` and `lib/presets.js`),
  so several of their statuses are now wrong. Section 9 lists which.

## Decisions taken on 2026-09-28

Settled by the maintainer after reading the first edition of this document.

1. **The client replaces the website entirely, mobile apart.** Everything in
   section 3.19 (the site-admin and director console, bans, requests, archived
   tournaments, articles, the Challonge import) is in scope, and so is every
   other **Decide** that asked "is the website staying for this".
2. **Player-reported scores come back**, as on the website: the create form and
   the details panel offer "Allow players to submit scores", and a player can
   submit a result with replay ids for the opponent to confirm. Finding 1.8
   is a defect, not a policy.
3. **Host game** is offered to the players of both sides and to anyone with
   organiser rights (organisers, directors on official events, site admins),
   and to nobody else.
4. **Share links**: open question, see the answer in the conversation. The
   proposal is to copy both links in the client, and to accept a pasted
   late-signup link in the client's own signup.
5. **The offline fake is not extended.** Nobody uses it. New actions get no twin
   in `infra/tourney_fake.rs`; what it already does stays so the existing tests
   keep running, and new behaviour is covered at the codec level against
   recorded server documents instead.

## How this was measured

Everything below was extracted mechanically from both trees and then checked
by reading the code where the extraction could not decide:

1. **Every server action.** All `sub === '...'` branches under `/api/t/{id}`
   (99), every `phase` action (10), every top-level route (28) and every series
   and site-admin verb, against every `act(...)`, `get(...)` and `post(...)` in
   `crates/faf-app/src/infra/tourney.rs`.
2. **Every field the server sends.** The keys of `publicView(t)`, of
   `view.viewer` and of the extra per-viewer keys set on the tournament `GET`,
   of the listing, of `/auth/faf/me` and of a match, against the keys
   `crates/faf-domain/src/protocol/tourney.rs` reads.
3. **Every control on the website.** Every `<button>`, heading and label of
   every render function in `public/app*.js` (242 lines of output), against
   every label our `ui/src/features/tournaments/**/*.tsx` renders, resolved
   through the English catalogue.
4. **Every request body.** For each action we do send, the keys the server
   reads against the keys we send, looking for a server assignment that is not
   guarded by `!== undefined`: a key we leave out that the server overwrites
   anyway.

### The numbers

| | Website | Client | Missing |
|---|---:|---:|---:|
| Per-tournament actions (`/api/t/{id}/…`) | 99 | 58 | **41** |
| `phase` actions | 10 | 6 (`close`, `form_teams`, `reopen_signups`, `set_captains`, `start_bracket`, `start_draft`) | **3** (`finish_early`, `undo_finish_early`, `set_captain_mode`; `generate` is an alias of `close`) |
| Top-level routes (`/api/…` and `/auth/faf/…`) | 28 | 9 | 19: 3 are the browser's OAuth round trip, most of the rest site administration |
| Tournament tabs | 13 | 10 | **4** (Matches, Stats, Vetoes, Maps); ours has Draft and Manage as tabs of their own |
| Fields of the tournament document not read | | | **38** (section 7) |

---

## 1. Findings that are wrong now, not merely missing

These come first because each one is a defect in what already ships.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| 1.1 | **Editing a map in the client wipes its spawn information.** `map_save` does `map.spec = cleanMapSpec(b.spec)` with no `undefined` guard, and our body never sends `spec`. | `server.js` `map_save`; `infra/tourney.rs` `save_map` | An organiser who fixes a typo in a map's note from the client deletes the team 1 / team 2 spawns, closed spawns, closed mexes and size that were entered on the website |
| 1.2 | **Swiss standings are ordered by the old rule.** We sort wins, then game difference, then seed. The server sorts wins, then **fewer losses**, then game difference **or** the "beaten opponents" sum with a seeded coin flip (`tiebreak`), then seed, and sends the result as `swissOrder` plus the numbers as `swissSB`. We read neither. | `tournament.rs:484` `standings()`; `server.js` `swissStandings`, `publicView.swissOrder` | Our table can disagree with the playoff seeds the server actually used; the README gives the exact case (a 3-2 with +4 out-ranking a 3-0 with +3) |
| 1.3 | **No player name in the tab opens the player card.** Nothing under `features/tournaments` calls `openPlayerCard`. | grep | Issue #158. A TO checking a bracket cannot get from a row to all of a player's ratings |
| 1.4 | **Replay ids cannot be recorded from the client.** The port and codec support `replayIds` and `drawReplayIds`, but `MatchReportDialog` always sends `replayIds: []`. | `MatchReportDialog.tsx:128` | Every result entered in the client loses its replays from the archive, and casters lose the links |
| 1.5 | **Starting a bracket with opponent picking on leaves the event with no way forward.** `start_bracket` answers `{picking: 1}` and opens a pick phase; the client has no pick phase UI and does not call `pick_opponent`. | `server.js` `start_bracket` | The draw waits for picks nobody can make from the client |
| 1.6 | **The Swiss start dialog asks for a round count that the server ignores** when record cuts are on (`rounds: cutRounds || c.rounds`). | `BracketSetupDialog.tsx`, `server.js` `start_bracket` | Misleading; the number typed is silently replaced |
| 1.7 | **"Host game" is offered to everyone on every playable match**, not to the two sides. | `BracketView.tsx` "Hosting is offered to everyone watching" | Issue #367 item 3 |
| 1.8 | **Events created in the client can never take player-reported scores.** `create_body` sends `playerReporting: false` on purpose, and nothing can turn it back on (`edit_info`'s "Allow players to submit scores" is not offered). The website's default is on. | `tourney-features.md` §3 "report_submit" | A decision of 2026-08-18 that contradicts "replicate the website" |
| 1.9 | **An organiser's forfeit or declared winner never reached the server.** Found while fixing 1.4: the service's `clean()`, meant to drop blank replay-id rows, also set `winner` and `forfeit` to `None`, and it ran on the organiser's `report` too. | `services/tourney.rs` `clean` | Every walkover and every declared winner entered in the client arrived as a bare match id, and the server refused it or recorded nothing |
| 1.10 | **Saving an event's settings in the client switched player reporting off.** Found while fixing 1.8: `edit_info_body` sent `playerReporting: false` just like `create_body`, so an event created on the website lost the setting the first time an organiser saved its details here. | `protocol/tourney.rs` `merge_shared` | Players of that event could no longer submit scores, with nothing on screen to say why |

### Status on `tourney/batch-1`

| # | Status |
|---|---|
| 1.1 | Fixed: `MapSpec` read and sent back unchanged |
| 1.2 | Fixed: `swissOrder`, `tiebreak` and `swissSB` read; "Beaten opp." column under that tiebreak |
| 1.3 | Fixed: #158 |
| 1.4 | Fixed: replay ids and draw replay ids in the organiser dialog, a pending submission accepted or rejected there, "FF" on the card |
| 1.5 | **Moved to the Swiss and playoffs batch**, together with the pick phase it needs |
| 1.6 | Fixed: record cuts read from the plan, the derived round count shown read-only. Editing the cuts belongs to the Swiss batch |
| 1.7 | Fixed: #367 item 3 |
| 1.8 | Fixed: the switch in both forms, `report_submit` with one replay id per new game, a "Submit score" dialog for players |
| 1.9 | Fixed, with a service test |
| 1.10 | Fixed, together with 1.8 |

### Status on `tourney/batch-2` (PR 373), re-measured against `2b6be08`

Re-run on 2026-09-28 against the website at `2b6be08` (21:37 +0200), which
added one feature since `d2cac09`: the **3rd place match** (a `3p` bracket
side, `third_place`, `plan.thirdPlace`, the Rounds/Bracket tab name once
playoffs exist). The client read a `3p` match as a second final; it is its
own side now.

Two more defects of the kind section 1 lists, found on the way:

| # | Finding | Status |
|---|---|---|
| 1.11 | **"Which rating counts" could not be changed from the client.** The settings form showed the select, and `edit_info` never sent `ratingType`. | Fixed |
| 1.12 | **A `3p` match was read as a winners match** with the final's round and index, so it was drawn on top of the final and ranked the semi-final losers level with the beaten finalist. | Fixed |

What batch 2 covers of section 3:

| Area | Done in batch 2 |
|---|---|
| 3.5 Chat | Layout, day dividers, replies with quote and jump, @ completion, ping the organisers, match chat as a popup |
| 3.8 Bracket / Rounds | Swiss rounds as a list with record chips, the 3rd place match, per-round best-of on the drawn bracket (`set_round_bo`) |
| 3.9 Matches | The tab, with per-match best-of in the details (`set_match_bo`) |
| 3.10 Vetoes | The tab, faction vetoes, the map veto run as the website runs it |
| 3.11 Maps | The public tab; secret maps, one or all (`map_secret`) |
| 3.14 Admin | Organisers remove and leave, bans, FAF renames, re-pull ratings, ending early (stop-at, finish, reopen), qualifier seed block, attached images, organiser notes, veto rules (Team A, reveal on ban) with their own save, multi-day events, check-in deadline, which rating counts |

**Actions still not called** (of 105 `sub` branches and the `phase` steps),
after taking out the browser's OAuth round trip (`login`, `logout`,
`callback`), an alias (`generate`), a dead one (`claim_organizer` answers
410) and two the client covers another way (`edit_date` through
`edit_info`, `faf_lookup` through FAF's own account search):

- Swiss and playoffs: `pick_opponent`, `undo_pick_opponent`, `playoff_setup`
- Teams: `org_create_team`, `signup_team`, `join_team`, `set_team_name`, `swap_team`, `set_match_team`, `replace_player`, `set_captain_mode`
- Maps: `copy_maps`, `pool_copy_sequence`, `set_maps`, `set_plan_round_bo`
- Vetoes: `fveto_reset`
- Players: `player_ratings` (issue 158's second half), `check_rating`, `cancel_invite`, `decline_invite`
- Decide: `secrets` (share links)
- Site administration: `set_category`, `stand_down`, `restore`

**Still open on screen**, checked on 2026-09-29 against every render
function of `public/app*.js` at `2b6be08` and the client's panels. Not
applicable and left out: whole-team registration (`signup_team`, off with FAF
login), instant team join (`join_team`, removed), organiser links
(`claim_organizer`, 410).

Every item is done on `tourney/batch-3` (2026-09-29, PR 375). What the client
does differently from the website, on purpose:

- Two actions the website's service takes and its pages never offer have a
  control of the client's own: a pool for one match (match details) and
  resetting one side's faction choices (`fveto_reset`); setting a match's
  sides by hand (`set_match_team`) is offered too, before the first game and
  to teams of the match's division only.
- The pending bar says each item in the reader's language, with the count
  the service put in its English sentence; an unknown kind keeps the
  service's words.
- A solo team's name opens the FAF player card rather than the website's
  one-row team popup; teams of several open the roster.
- Replays on a card play in the client instead of linking to the vault page.
- The pool view's "how the veto will run" footer reads `veto.mode`; the
  website reads a field the service never sends and always says "before
  game 1".
- A director is not offered Restore on archived tournaments, which the
  service refuses them although the website shows it.
- For a site admin the Manage button that archives says it deletes
  permanently, which is what the service does for that role.
- "Fill from this" does not copy the rating date (the website does, while
  saying it copies no dates) and does copy the free-for-all settings (the
  website forgets them).
- `copy_maps` copies no spawn information: a website fault the client does
  not work around.

**Fields still not read**: `archived`, `cfg`, `challongeDate`, `chatLockAt`,
`createdByName`, `hasOrganizer`, `rounds`, `source`, `unreadByRoom` (the
recorded-document tripwire in `crates/faf-domain/tests/recorded_tourney.rs`
is the list's authority).

---

## 2. The two open issues, item by item

### Issue #367 (Nuggets, 2026-09-26)

| Item | Status | What it takes |
|---|---|---|
| 1. The chat is badly formatted | **Confirmed** from the screenshot: messages run in a column about 700 px wide in a 1,900 px pane, the panel does not use the height, and there are no day dividers | Section 3.5: layout, day dividers, replies |
| 2. "Bracket" is called Rounds on the website | **Confirmed**: `tabLabel` says Rounds for Swiss and FFA, and the stepper's last step too | One label and one stepper step |
| 3. The rounds view is spread out, and has a Host game button | **Confirmed**: a Swiss round is drawn as a bracket column with the score at the far right edge; Host game is finding 1.7 | Section 3.8: Swiss rounds as the website draws them |
| 4. Manage does not have all options | **Confirmed**: 12 of the website's 23 Admin panels are missing or partial, and 2 more need a decision | Section 3.14 |
| 5. The Matches tab is missing | **Confirmed** | Section 3.9 |
| 6. Ongoing should be above Upcoming | **Confirmed**: we order drafts, upcoming, ongoing, past | `groupedEvents` order |

### Issue #158 (wlsn, 2026-09-10)

| Ask | Status |
|---|---|
| Player names link to the FAF account | **Missing** (finding 1.3). Every entrant who signed up with FAF login has a `fafId`, from either side, so the link is possible for all of them. Only pre-OAuth imports have none |
| A TO sees all of a player's ratings, not only the counting one | **Missing**. The website has it as `player_ratings` (organiser-only, all five boards, with re-pull). The player card would answer it as well once 1.3 is fixed |

---

## 3. Area by area

Status: **Done** (reachable and matching), **Partial** (what is missing is
named), **Missing**, **Decide** (a question for the maintainer, not a gap).

### 3.1 The list of tournaments (website home)

| Website | Client | Status |
|---|---|---|
| Sections: My drafts, **Ongoing**, Upcoming / Open, Completed | Your drafts, Upcoming, **Ongoing**, Finished or called off | **Partial**: order (#367.6) |
| Upcoming sorted soonest first, undated last | Same (`fede312`) | **Done** |
| Completed collapsed, **split by year**, **50 per page** with "Show N more" | Collapsed, one flat list | **Partial** |
| Card: name, OFFICIAL / COMMUNITY badge, status pill | Same | **Done** |
| Card: kind (`1v1 SE`, `2v2 Swiss`, `FFA`) | Absent from the card | **Missing** |
| Card: "N signed up", date | Same | **Done** |
| Card: event-days chip ("2 days", with the span on hover) | | **Missing** (`eventDays` not read) |
| Card: rating range and team cap | | **Missing** |
| Card: min–max entrants | | **Missing** |
| Card: cash prize | | **Missing** |
| Countdown chips: "Signups start in", "Event starts in", "Signups close in" | "Signups in …" only | **Partial** |
| Pill "Signups not open yet" (distinct from Signups open) | Countdown instead | **Partial** |
| "draft · view only" badge for a director on someone else's draft (`canManage`) | | **Missing** (`canManage` not read) |
| Site admin: Delete from the list | | **Decide** (section 3.19) |

### 3.2 Site-wide navigation and cross-tournament state

| Website | Client | Status |
|---|---|---|
| Top bar: Overview, Hall of Fame, Series, FAQ / Rules, Host tournament, Import, role badges (SITE ADMIN, DIRECTOR, EDITOR), ADMIN ON/OFF, display settings | New tournament, View online, Refresh | **Partial** |
| **Pending bar** (`GET /api/my/pending`): every veto turn, faction veto, draft pick, opponent pick, score to confirm and invite, across every tournament, with Go / Review | | **Missing** |
| Access-request alert for site admins and directors (`my/dismiss_requests`) | | **Decide** |
| Hall of Fame (`/hall`, `GET /api/halloffame`): players and teams by championships | | **Missing** |
| Series index (`/series`): running now vs dormant, Official only filter, colours, create | Series are editable in Manage only | **Missing** as a page |
| Series page (`/series/{id}`): editions newest first with format, date, status, winner; series winners tally; manage (rename, type, colour with preview, description, delete); **series bans** | Loaded into the slice (`series_detail`), no page | **Missing** |
| FAQ / Rules articles, with sub-pages | Folded into the Overview as a disclosure | **Partial** (no sub-pages, no own page) |
| Discord-handle reminder (`maybeRemindDiscord`) | Asked once in the signup dialog | **Done** differently |

### 3.3 The tournament header and shell

| Website | Client | Status |
|---|---|---|
| Name, category badge, type line (format, preset name, stage two, record cuts, ends-early), event-days span | Name, format, bracket kind, date | **Partial** |
| Status pill in the header | Only in the list | **Missing** |
| **Stage stepper**: Signups ▸ Teams/Draft ▸ Bracket/Rounds ▸ Results | | **Missing** |
| **Turn banner** at the top of every tab (map veto, faction veto, draft pick, opponent pick, score to confirm), plus ● in the window title | Per-panel "Your turn" text only | **Missing** |
| **View as player** (organisers; hides organiser controls, no permission change) | | **Missing** |
| **Show players** (team names become their players everywhere) | | **Missing** |
| **Streamer mode** (results, scores, advancement and standings hidden; per-match Reveal; auto-on for casters once running) | | **Missing** |
| Hotkeys F / S / V, rebindable | | **Missing** |
| Tabs shown by state: Chat only for participants, organisers and casters; Matches once matches exist; Stats once finished; Vetoes when map or faction vetoes are active | Chat always; no Matches, Stats, Vetoes, Maps | **Partial** |
| Tab labels: Teams reads Draft during the draft; Bracket reads **Rounds** for Swiss and FFA; Vetoes shows the open count | Draft is its own tab; Bracket always | **Partial** (#367.2) |
| Draft banner with Copy share link, Publish now, **Schedule** (UTC), **Cancel schedule** | Publish in Manage | **Partial** |
| Enter / Check in / Withdraw | In the header | **Done** |

### 3.4 Overview

| Website | Client | Status |
|---|---|---|
| Livestreams | Same | **Done** |
| Latest update, hidden once finished | Same | **Done** |
| Champion | Same | **Done** |
| Rewards with the cash-prize box, Sponsors | Same | **Done** |
| Game Setup: format, rating requirements (source line in bold first), lobby options, mods, briefing, images | Same | **Done** |
| Game Setup **Schedule** cell for multi-day events ("no play on the days in between") | | **Missing** |
| Game Setup "**Ends when N are left**" cell with a live count | | **Missing** |
| "Don't know your rating? Click here", jumping to the rating check | | **Missing** |
| **Organisers, one per row, with Discord handles** (`organizersPublic`) | Read, not shown | **Missing** |
| **Recent results** | | **Missing** |
| Banners: veto turn, @mention, organiser ping (organisers), your ban (`myBan`) | | **Missing** |
| Qualification block, both directions ("top N here go to X", "the field comes from") | Same | **Done** |
| Series block in the series colour | Present, uncoloured | **Partial** |
| Inline "Edit details" for organisers | In Manage | **Done** differently |

### 3.5 Chat

| Website | Client | Status |
|---|---|---|
| Rooms: Global, Captains, Staff, one per match once both teams are known | Server-driven, all arrive | **Done** |
| Completed matches' rooms grouped and collapsed | Same | **Done** |
| @mention badge, organiser ping badge | Same | **Done** |
| Soft unread marker (distinct from the @mention badge) | Unread count badge | **Partial** |
| **Day dividers**, full date on hover, viewer's time format | | **Missing** |
| **Replies** with a quoted snapshot, click to jump and flash (`replyTo`) | Not sent, not read | **Missing** |
| **@name autocomplete** (players and team names) and highlighting | | **Missing** |
| **@everyone** (organisers only) | Typing works; no hint | **Partial** |
| `!organizer` and a **Ping organizer** button | Typing works; no button | **Partial** |
| `!roll` | Typing works | **Done** |
| **Pre-start notice** with the organisers' Discord handles | | **Missing** |
| **Pin a chat to the right** (one at a time, closes itself with a reason, survives tab switches) | | **Missing** |
| Match chat reachable from the bracket, Vetoes and Matches (popup) | Only from the Chat tab | **Missing** |
| Lock two days after the end | Same | **Done** |
| Mute, unmute, delete (organisers) | Same | **Done** |
| Layout (#367.1) | Narrow column, not full height | **Partial** |

### 3.6 Players

| Website | Client | Status |
|---|---|---|
| Table: #, name, rating, team, seed, check-in, placing, badges | Same | **Done** |
| **Names link to the player** | | **Missing** (1.3) |
| Sign up, Discord handle | Header button and dialog | **Done** |
| **Manual rating at signup** for an unrated event (`ratingType: none`) | Signup sends `{}` | **Missing** |
| Rating-source callout at the top of the signup panel | In the Overview | **Partial** |
| **Check my rating for this tournament** (`check_rating`, writes nothing) | | **Missing** |
| Invited: Accept or **Decline invite** (`decline_invite`) | Accept only, by signing up | **Partial** |
| Request mode: Withdraw request | Withdraw | **Done** |
| Banned: told before pressing anything (`myBan`) | | **Missing** |
| Organiser: Add to tournament by FAF name or id | Same | **Done** |
| Organiser: Invite, Uninvite, Accept / Decline a pending signup | Same, in Manage | **Done** |
| Organiser: **Ratings** (all five boards, `player_ratings`) with **Re-pull from FAF** | | **Missing** (#158) |
| Organiser: **Replace** a player (from standby, or anyone on FAF by name or id) | | **Missing** |
| Organiser: Edit (name, note, team name, rating) | Note and rating | **Partial** |
| Organiser: **Ban** (with reason and expiry, removes where it still can) | | **Missing** |
| Seeding panel on the Players tab for a solo field (Randomize, By rating, **By invite**, Save) | In Manage; no "by invite" | **Partial** |
| Late signup through the organiser's link (`?late=`) | | **Decide**: a link the client cannot receive |

### 3.7 Teams and draft

| Website | Client | Status |
|---|---|---|
| Create, rename (captain's one rename), disband, leave | Same | **Done** |
| Invite to team, accept / decline invites | Same | **Done** |
| Request to join, withdraw request, answer requests | Same | **Done** |
| **Cancel an invite** (`cancel_invite`) | | **Missing** |
| Transfer captaincy (captain or organiser) | Organiser only, in Manage | **Partial** |
| Sections: Participants, **Waiting list**, **Forming**, Free agents | Teams and free agents | **Partial**: the first-come-first-served cut and the waiting list are not shown |
| Free agents panel sortable by rating, name, newest, with pool average | Table | **Partial** |
| Check in, **Undo check-in**, organiser checks a team in | Check in only | **Partial** |
| Check-in deadline shown read-only | | **Missing** |
| Organiser: **Swap a waiting team in** (`swap_team`) | | **Missing** |
| Organiser: **New team from a free agent** (`org_create_team`) | | **Missing** |
| Organiser: assign a player to a team, move, take off | Same | **Done** |
| Projected seed per team before seeds lock | | **Missing** |
| Divisions: split, move a team | Same | **Done** |
| Draft: captains, pick, undo pick, pick order display, pool | Same | **Done** |
| Draft: **How captains are chosen** (by hand, or the top N by rating, with a live preview) (`set_captain_mode`) | By hand only | **Partial** |
| Draft: a captain can undo their own last pick until the next pick | Organiser undo | **Partial** |

### 3.8 Bracket / Rounds

| Website | Client | Status |
|---|---|---|
| Single and double elimination with connectors | Same | **Done** |
| First-round byes not drawn (the seed appears straight in round 2), phantom losers matches hidden (`isPhantomMatch`) | Bye matches are drawn as cards; nothing filters them | **Missing** |
| Divisions (King / Prince), one bracket each | Division field read, not drawn per division | **Partial** |
| **Format preview before generation** (bracket, Swiss, FFA) | | **Missing** |
| **Per-round Bo** on the preview and on the live bracket (`set_plan_round_bo`, `set_round_bo`) | | **Missing** |
| **Per-match Bo** from the match details (`set_match_bo`) | | **Missing** |
| Swiss rounds: each match shows its **score group** (`2-1`, `2-1 vs 1-2`), rounds best group first | One bracket column per round | **Missing** (#367.3) |
| Swiss **round 1 editor** (arrange by hand or draw at random, pinned until start) (`swissR1Open`, `plannedR1`) | | **Missing** |
| **Record cuts** (N wins advance, N losses out), deciding-match Bo | | **Missing** |
| **Two stages**: Swiss into a playoff bracket, above the Swiss rounds | | **Missing** |
| **Playoffs panel** (who picks, order within a record, clock) (`playoff_setup`), Undo the last pick, **Redo the playoffs** | | **Missing** |
| **Opponent pick phase** (`pick_opponent`, `undo_pick_opponent`), with clock | | **Missing** (1.5) |
| **Ends early / survivors**: banner, countdown, "Not played" matches | | **Missing** |
| FFA rounds and lobbies, winners or points | Same | **Done** |
| Team popup (members, ratings, captain, seed, combined rating) | | **Missing** |
| Replay ids as links, per game as soon as confirmed | | **Missing** |
| Map pool per round, "Show pool", "How the veto will run" popup | Pool per round | **Partial** |
| Organiser corrects a result | Same | **Done** |
| Organiser: set a match's teams (`set_match_team`) | | **Missing** |
| Host game (client only) | Everyone, every match | **Partial** (1.7) |

### 3.9 Matches tab

**Missing** as a whole. What it is on the website: a flat list in four
sections (My matches, Ongoing & upcoming, Not yet decided, Concluded), columns
round / both teams / status / result, your own matches tinted, status as a
pipeline (Waiting → Picks & bans → Ready/Live → Concluded, faction choices
included), a details popup (both rosters with ratings and captain, score,
winner, full ban/pick history, replay ids, match-chat link, report on the same
terms as the bracket), and streamer-mode aware with Reveal / Hide per row.

### 3.10 Vetoes

| Website | Client | Status |
|---|---|---|
| Map veto: grid, turn, A/B sides, undo, decider | Same, under the bracket | **Done** |
| A **Vetoes tab**: My matches / All vetoes, in progress first, completed after | Under the bracket, one at a time | **Missing** as a tab |
| **Two-click** ban / pick with "Confirm ban?" | One click | **Missing** |
| BAN / PICK colour badge and "your turn" line | Text | **Partial** |
| Numbered ban / pick log, which team did what | Picks per game | **Partial** |
| **Secret maps** ("Hidden Map N" until played; reveal on ban optional) (`map_secret`) | | **Missing** |
| CLOSED veto when a match is settled mid-veto | | **Missing** |
| Veto statistics on a finished event (most banned, most played; organisers, directors, admins) | | **Missing** |
| **Faction vetoes** (1v1: bans each, picks each, secret, per game) (`fveto_config`, `fveto_action`, `fveto_reset`) | | **Missing** |

### 3.11 Maps

| Website | Client | Status |
|---|---|---|
| A public **Maps tab**: pools first, then All maps, "Played in", "In pool" | In Manage, organisers only | **Missing** as a tab |
| Map database: add, edit, publish, delete, Publish all | Add from FAF's vault, edit, publish, delete | **Done**, plus the vault search the website lacks |
| **Structured spawn info** (team spawns, closed spawns, closed mexes as 1–16 toggles, size) | | **Missing**, and editing wipes it (1.1) |
| **Map image upload** (5 MB) and remove | Vault previews only | **Partial** |
| **Secret** flag | | **Missing** |
| Pools: name, maps, Bo, ban / pick order with Standard order and step editing | Same | **Done** |
| Pool **scheduled publishing** (UTC) | | **Missing** |
| **Copy ban / pick order** to other pools (`pool_copy_sequence`) | | **Missing** |
| **Import maps from another tournament** (`copy_maps`, `GET /api/my_tournaments`) | | **Missing** |
| Assign a pool to rounds or matches, before or after generation | Rounds | **Partial**: per match |

### 3.12 Standings

| Website | Client | Status |
|---|---|---|
| Swiss, points and final standings | Computed client-side | **Partial**: wrong order (1.2) |
| **Beaten opp.** column when that tiebreak is on | | **Missing** |
| Imported group tables and final placings | Final placings | **Partial** |
| Hidden in streamer mode | | **Missing** |

### 3.13 Stats

**Missing** as a whole. On the website, once finished: entrants and players,
teams, series and games played (a walkover counts no games), different maps,
vetoes completed, forfeits, average rating, team ratings, highest-rated
player, most-played maps, longest series. Computed in the browser from the
tournament document, so it needs no new endpoint.

### 3.14 Admin (our Manage)

The website's Admin tab has 23 panels. Ours covers 9 fully and 6 partly in Manage; 6 are missing and 2 need a decision.

| Website panel | Client | Status |
|---|---|---|
| Share links (`secrets`: late-signup link) | | **Decide** |
| Tournament details (name, dates, signups, min/max) | Settings | **Done** |
| **Multi-day event picker** (click, shift-click range, ctrl-click) | | **Missing** |
| Qualifiers: add, remove, rule, **seed from** (`qualifier_seed`) | Add, remove, rule | **Partial** |
| Series | Same | **Done** |
| Organisers: add, hide, **remove**, **leave**, "add myself" | Add, hide | **Partial** (`remove_organizer` is organiser-level now) |
| Casters | Same | **Done** |
| Format: competition, size, formation, draft order, bracket | Same | **Done** |
| Format: per-round Bo switch, match lengths plan | Plan at creation only | **Partial** |
| Format: grand-final handicap, Swiss final, fast pairing | At creation | **Partial** |
| Format: **record cuts**, **stage two**, **ends early**, **opponent picking**, **tiebreak** | | **Missing** |
| Format: FFA block (per lobby, mode, rounds, cut, final, advancing) | At creation | **Partial** |
| **Playoffs** (who picks, order within a record, clock; editable while the Swiss runs) | | **Missing** |
| Seeding, signups mode | Same | **Done** |
| **Allow players to submit scores** | Forced off (1.8) | **Missing** |
| **Player names**: check for FAF renames, apply selected (`check_renames`, `apply_renames`) | | **Missing** |
| Game setup: description, lobby options, mods | Same | **Done** |
| Rewards, cash prize, sponsors, livestreams | Same | **Done** |
| Muted in chat | Same | **Done** |
| Rating requirements (min, max, team cap, clamp) | Same | **Done** |
| **Which rating counts**, editable later, and **Re-pull every rating** (`repull_ratings`) | At creation | **Partial** |
| Rating date | Same | **Done** |
| Map vetoes: enable, Team A rule, **reveal secret on ban**, when | Enable and when at creation | **Partial** |
| **Faction vetoes** | | **Missing** |
| Organiser notes (static help: substitutions, pools, news, running scores, corrections) | | **Missing** |
| **Attached images** (upload, remove, up to 10) | Shown, not uploadable | **Partial** |
| Category (site admin) | | **Decide** (section 3.19) |
| **End early**: survivor count mid-event, End here and lock standings, Reopen (`set_stop_at`, `finish_early`, `undo_finish_early`) | | **Missing** |
| **Bans** for this tournament (`ban_set`, `ban_remove`) | | **Missing** |
| Archive, abandon, undo abandon | Same | **Done** |

### 3.15 Log

Organiser activity log (`tlog`): **Done**.

### 3.16 Creating a tournament

| Website | Client | Status |
|---|---|---|
| **Format presets** (Invitational, LotS), restricted to directors and site admins (`GET /api/presets`, `presetId`) | | **Missing** |
| "Fill from this" (copy an existing tournament as the next edition, streams not copied) | | **Missing** |
| Name, dates, description, lobby options, mods, prize, rewards, sponsors, streams | Same | **Done** |
| **Check-in deadline** at creation | | **Missing** (and `edit_info` does not resend it) |
| **Event days** | | **Missing** |
| Competition, type (category), series, team size, formation, draft order, bracket | Same | **Done** |
| Match lengths plan, grand-final handicap, Swiss final, fast pairing | Same | **Done** |
| Record cuts, stage two, ends early, opponent picking | | **Missing** |
| FFA block | | **Missing** at creation (`perMatch`, `mode`, `rounds`, `cutTo`, `finalSize`, `advance` are not sent) |
| Min / max entrants, seeding, rating used, rating date, rating limits, signups mode | Same | **Done** |
| Map vetoes: enable, Team A rule, when | Enable and when | **Partial** |
| Images pasted into the rich-text fields at creation | | **Missing** |
| Host permission request (`host_request`) when not approved | | **Missing** (`host_status` is read) |

### 3.17 Roles and permissions

| Website | Client | Status |
|---|---|---|
| Organiser, caster, captain, player | `viewer.organizer`, `viewer.caster`, team membership | **Done** |
| **Site admin and director flags** from `/auth/faf/me` (`siteAdmin`, `director`, `editor`, `importer`) | Only `discord` is read | **Missing**. The August reason for leaving site-admin actions out ("nothing says whether this account is a site admin") no longer holds |
| **Stand down** (ADMIN ON/OFF) | | **Decide** |
| Directors see every draft, organise official ones only | Works through the server | **Done** |
| Map-prep access narrower than organiser rights | Server-enforced | **Done** |

### 3.18 Personal display settings

| Website | Client | Status |
|---|---|---|
| Time zone, date format, time format, UI scale | The client's own locale and settings | **Done** differently |
| Hotkeys | | **Missing** (3.3) |

### 3.19 Site administration

The `/siteadmin` console (requests for hosting, editors and importers; site
admins; directors; **global tournament bans**; audit log; archived tournaments
with restore and delete; FAQ articles), the `/editor` and `/importer` pages, and
the Challonge import.

**Decide.** They administer the site rather than a tournament, and most are
used by a handful of people. The directors' part (bans, requests, archived) is
what a TD needs day to day. If the client is to replace the website entirely,
these belong in scope; if the website stays for administration (Nuggets wants
it kept for mobile use anyway), they do not.

---

## 4. Every per-tournament action

`✓` the client sends it, `–` it does not.

| Action | | Action | | Action | |
|---|---|---|---|---|---|
| abandon | ✓ | add_caster | ✓ | add_desc_image | – |
| add_organizer | ✓ | apply_renames | – | ban_remove | – |
| ban_set | – | cancel_invite | – | cancel_join | ✓ |
| chat_delete | ✓ | chat_mute | ✓ | chat_post | ✓ |
| chat_read | ✓ | chat_rooms | ✓ | check_rating | – |
| check_renames | – | checkin_team | ✓ | claim_organizer | – (410 now) |
| copy_maps | – | create_team | ✓ | decline_invite | – |
| delete | ✓ | disband_team | ✓ | edit_date | – |
| edit_format | ✓ | edit_info | ✓ | edit_player | ✓ |
| faf_lookup | – | fveto_action | – | fveto_config | – |
| fveto_reset | – | invite_player | ✓ | invite_to_team | ✓ |
| join_team | – (refused) | leave_team | ✓ | map_delete | ✓ |
| map_publish | ✓ | map_save | ✓ (1.1) | map_secret | – |
| move_player | ✓ | news_delete | ✓ | news_edit | ✓ |
| news_post | ✓ | news_read | ✓ | org_add_player | ✓ |
| org_create_team | – | organizer_visibility | ✓ | phase | ✓ |
| pick | ✓ | pick_opponent | – | player_ratings | – |
| playoff_setup | – | pool_assign | ✓ | pool_copy_sequence | – |
| pool_delete | ✓ | pool_publish | ✓ | pool_save | ✓ |
| publish | ✓ | qualifier_add | ✓ | qualifier_remove | ✓ |
| qualifier_seed | – | remove | ✓ | remove_caster | ✓ |
| remove_desc_image | – | remove_organizer | – | rename_team | ✓ |
| replace_player | – | report | ✓ | report_confirm | ✓ |
| report_submit | – | repull_ratings | – | request_join | ✓ |
| reseed | ✓ | respond_invite | ✓ | respond_join | ✓ |
| respond_signup | ✓ | restore | – | secrets | – |
| set_captain | ✓ | set_category | – | set_division | ✓ |
| set_maps | – (legacy) | set_match_bo | – | set_match_team | – |
| set_plan_round_bo | – | set_round_bo | – | set_series | ✓ |
| set_stop_at | – | set_team_name | – (legacy) | signup | ✓ |
| signup_team | – (legacy) | split_divisions | ✓ | swap_team | – |
| undo_pick | ✓ | undo_pick_opponent | – | uninvite_player | ✓ |
| veto_action | ✓ | veto_setab | ✓ | veto_undo | ✓ |

Of the 41 missing: 4 are legacy or refused (`set_maps`, `set_team_name`,
`signup_team`, `join_team`), 2 are superseded (`claim_organizer` answers 410,
`edit_date` duplicates `edit_info`), 1 is covered differently (`faf_lookup`,
by FAF's own player search), and **34 are features**.

`publish` is sent without `publishAt` or `cancelSchedule`, so scheduled
publishing is missing even though the action is used.

## 5. Top-level routes

| Route | Client |
|---|---|
| `GET /api/tournaments`, `POST /api/tournaments` | ✓ |
| `GET /api/host_status` | ✓ |
| `POST /api/host_request` | – |
| `GET /api/articles` | ✓ |
| `GET /api/series`, `GET /api/series/{id}` | ✓ |
| `POST /api/series` create, update, delete | ✓ |
| `POST /api/series` ban_set, ban_remove | – |
| `POST /api/my/profile` | ✓ |
| `GET /auth/faf/me` | ✓ (only `discord` read) |
| `GET /api/my/pending` | – |
| `POST /api/my/dismiss_requests` | – |
| `GET /api/my_tournaments` | – |
| `GET /api/presets` | – |
| `GET /api/halloffame` | – |
| `POST /auth/faf/stand_down` | – |
| `editor_status`, `editor_request`, `importer_status`, `importer_request`, `admin_lookup`, `siteadmin` (22 verbs), `import_challonge` | – (section 3.19) |

## 6. What changed on the website since 2026-08-19

Nineteen per-tournament actions and three `phase` actions did not exist when
the last audit was written:

`apply_renames`, `ban_remove`, `ban_set`, `check_rating`, `check_renames`,
`fveto_action`, `fveto_config`, `fveto_reset`, `map_secret`, `pick_opponent`,
`player_ratings`, `playoff_setup`, `qualifier_seed`, `repull_ratings`,
`set_match_bo`, `set_stop_at`, `swap_team`, `undo_pick_opponent`, plus
`stand_down` on `/auth`; and `finish_early`, `undo_finish_early`,
`set_captain_mode` under `phase`.

Features behind them, by the README: record-cut Swiss, the seeded random draw
and cross-stream deciding round, two-stage events, opponent picking with three
modes and a clock, the playoffs panel with undo and redo, ending early,
presets, faction vetoes, secret maps, the Matches tab, the Stats tab, pinned
chats, replies, day dividers, the pending bar, bans in three scopes, casters as
an account role, multi-day events, rating checks and all-board ratings, rename
sync, the swap of a waiting team, the stand-down switch.

## 7. Fields the client does not read

From the tournament document: `aliveCount`, `archived`, `bans`,
`captainCount`, `captainMode`, `cfg`, `challongeDate`, `chatLockAt`,
`chatPingCount`, `createdByName`, `earlyFinish`, `entryKey` (per team),
`eventDays`, `fveto`, `hasOrganizer`, `importedGroups`, `importedStandings`,
`importedType`, `invited` (viewer), `maps` (legacy), `mapsView` (viewer),
`myBan`, `myMentionCount`, `myUnreadCount`, `oauthEnabled`, `pickMinutes`,
`pickMode`, `pickOpponents`, `plannedR1`, `playoffs`, `preset`, `presetName`,
`seedFrom` (per qualifier), `source`, `sourceUrl`, `stage2`, `stage2Seed` (per
team), `standingsOnly`, `stopAtAlive`, `streamer` (viewer), `survivors`,
`swissOrder`, `swissR1Open`, `swissSB`, `tiebreak`.

From a match: `forfeit`, `fveto`, `games`, `secret`, `drawReplayIds`.

From the listing: `canManage`, `challongeDate`, `eventDays`.

From `/auth/faf/me`: everything but `discord` (`fafId`, `fafName`, `editor`,
`importer`, `director`, `siteAdmin`, `siteAdminAccount`, `adminStandDown`).

## 8. What any of this costs besides the UI

- **The offline fake.** `infra/tourney_fake.rs` (3,377 lines) reimplements the
  server so the tab works without one. Every new action needs a twin there, or
  a decision that the fake stops following the website.
- **The twins.** Rules that decide what a button offers exist in Rust and in
  `ui/src/shared/rules/tourneyRules.ts` and are pinned by the conformance
  fixture. Swiss standings (1.2) should become "read `swissOrder`" rather than
  a third implementation of the server's tiebreak.
- **The bindings.** Every new field is a domain type change: bindings,
  fixture and `store.ts`'s `INITIAL`.
- **No server work.** The client talks to the same server with a Bearer token,
  so replicating the website is client work only.

## 9. Statuses in `tourney-features.md` that are now wrong

| Old status | Now |
|---|---|
| `remove_organizer` **Out**: site-admin-only | Organiser rights; any organiser may remove another, or leave |
| `set_category`, `restore` **Out**: "nothing says whether this account is a site admin" | `/auth/faf/me` says so (`siteAdmin`, `director`) |
| The caster link **Blocked** | Casters are an account role; `add_caster` / `remove_caster` are built |
| `report_submit` **Out**, `playerReporting: false` forced | Contradicts "replicate the website": 1.8 |
| Standings **Done** | Wrong order for Swiss: 1.2 |
| Bracket **Done** | Swiss rounds, record cuts, two stages, picks and early endings are all missing |
| Chat **Done** | Replies, dividers, autocomplete, pin and the pre-start notice are missing |
| Maps **Done** | Spawn info, secret maps, images, scheduled pools, copying are missing, and 1.1 |
