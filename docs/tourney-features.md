# The tournament tab: every feature, and where it stands

Written by reading `server.js` (109 per-tournament actions, 16 top-level routes)
and the website's own `public/app*.js` (~8,500 lines). The point of the list is
that "build the rest of the website" is otherwise unanswerable: there is no
schema, no API document, and no feature list on the far side.

Last checked against the tree on 2026-08-18, by tracing every `TourneyCommand`
back to a sender in the UI. Four rows had said **Done** for a command nothing
sent; two had said **Todo** for one that had shipped. A status here means
reachable, not merely implemented.

Status is one of:

- **Done**: implemented, tested, and green.
- **Partial**: reachable but incomplete. What is missing is named.
- **Todo**: not started.
- **Out**: deliberately not in the client. The reason is given, and a reason is
  not a refusal: say so and it moves.

## 1. Pages

The website is nine pages. The client is one tab, so most of them become
sections of it rather than places of their own.

| Website page | Client | Status |
|---|---|---|
| Home (tournament list) | The list pane | **Done** |
| Tournament | The detail pane | **Partial** (below) |
| `/host` (create) | The create dialog | **Done** |
| `/series` and `/series/{id}` | Part of Manage: the series picker, a series editor, and the qualifier links | **Done** (2026-08-18). The browsing half (a series page of its own, listing every edition) is loaded and held in the slice but has no page yet |
| `/hall` (Hall of Fame) | A section | **Todo** |
| `/faq` | Folded into Rules | **Done** |
| `/siteadmin` | none | **Out**: needs the site-admin password, and it administers the *site*, not a tournament |
| `/editor` (articles) | none | **Out**: an editor for site-wide prose, used by two people |
| `/importer` (Challonge import) | none | **Out**: Challonge was just removed |

## 2. The tournament, section by section

| Section | Status | What is missing |
|---|---|---|
| Overview | **Done** | Prize, rewards, sponsors, streams, lobby options and mods are not shown |
| Rules / FAQ | **Done** | Description images |
| News | **Done** | Posting, correcting, deleting, an important flag, and an unread badge per account that clears on every device |
| Entrants | **Done** | Shows people, teams, seeds, check-in and placings |
| Teams | **Done** | Form one, ask to join, answer requests, invite, leave, rename, disband. Only shown where there are teams to form |
| Bracket | **Done** | Drawn from `winnerTo`/`loserTo`. Swiss and FFA rounds render as one column but have no standings table |
| Standings | **Done** (2026-08-18) | Swiss records, elimination placings with shared ranks, free-for-all points, and an import's own final table. **Missing**: imported *group* tables (`importedGroups`) |
| Chat | **Done** | Rooms split into live and completed, badges for `@mention` and the organiser ping, moderation on the post itself, a closed composer for a silenced account, and the silenced list in Manage. Polled while a room is open, because the service has no push. **Missing**: the organiser callout with Discord handles, the pre-start note, and a button for `!organizer` (typing it works) |
| Maps | **Done** (2026-08-18) | The map database filled from FAF's vault by search, the pool editor with its ban/pick order, and binding a pool to a round, before or after the draw. **Missing**: `copy_maps` and `pool_copy_sequence`, both conveniences for reusing one event's work in another, and map images, which are uploaded as data URLs |
| Vetoes | **Done** (2026-08-18) | The ban/pick grid, whose turn it is, the run so far and the decider. `veto_action`, `veto_setab`, `veto_undo` |
| Draft | **Done** (2026-08-18) | The pick order, whose pick is due, the undraft pool, and taking a pick back. `pick`, `undo_pick`, `set_captains`, `start_draft` |
| Manage | **Done** | Settings, format, lifecycle, entrant administration, invitations, seeding, divisions, map pools, organisers, series and qualifiers, silenced accounts, abandon, archive |
| Audit log | **Done** (2026-08-18) | `tlog`, organiser-only, newest first |

Standings are computed, not fetched: the service sends no table, so `Tourney::standings` works one out from the matches and each team's exit. That makes it a rule with three implementations (Rust, the client twin, the website), which is why it is pinned by the conformance harness.

## 3. Endpoints, grouped by what they are for

### Lifecycle

| Endpoint | Status |
|---|---|
| `POST /api/tournaments` | **Done** |
| `publish` | **Done** (2026-08-18). Shipped unreachable: the command, port, fake and service arm existed, and nothing sent it, so every event created here stayed a draft only its organiser could see |
| `phase` → `form_teams`, `start_bracket`, `reopen_signups` | **Done** |
| `phase` → `set_captains`, `start_draft` | **Done** (2026-08-18) |
| `delete` (archives for a non-admin) | **Done** |
| `edit_info` | **Partial**: name, description, all three dates (event, signup close, rating date), rating gate, signup mode. Missing rewards, prize, sponsors, streams, lobby options, mods, check-in deadline, veto |
| `reseed`, `split_divisions` | **Done** |
| `set_division` | **Done** (2026-08-18): a per-team picker in the team admin, shown once the field is split |
| `edit_format` | **Done** (2026-08-18): competition, team size, formation, draft order, bracket type. The best-of plan stays on the website. The two locks are mirrored rather than discovered: the whole format closes at the draw, the team setup one step earlier at the end of signups |
| `edit_date` | **Out**: `edit_info` already writes the name and all three dates, and a second path to the same four fields is the pattern that produced the unreachable commands above. Its only extra fields are `minTeams`/`maxTeams` |
| `report_submit` (the player path) | **Out, and now actively closed.** Both write bodies send `playerReporting: false` rather than leaving the key out, because the service reads an absent one as *on*. Every event created here is organiser-reported |
| `abandon` | **Done** (2026-08-18): reversible, and set apart from archiving because it leaves the event visible |
| `set_category`, `restore` | **Out**: both are site-admin-only, and nothing the service sends says whether this account is a site admin (`viewer.admin` is an *admin-token* holder). The button would answer "Site admin only" for every ordinary organiser |
| `set_plan_round_bo`, `set_round_bo` | **Todo** |

### Signups

| Endpoint | Status |
|---|---|
| `signup` | **Done** |
| `remove` (self-withdraw) | **Done** |
| `checkin_team` | **Done** |
| `org_add_player` | **Done** |
| `respond_signup` (request mode) | **Done** |
| `invite_player`, `uninvite_player` | **Done** |
| `faf_lookup` | **Done differently**: the organiser's add and invite fields search *FAF's* own player API (`PlayerCardPort::search_players`, the same lookup behind the player card) and send the chosen login. The tournament server's own lookup endpoint is not called, because the client already had a player search with avatars and ratings and a second one would only disagree with it |
| `edit_player` | **Done** |
| `replace_player`, `decline_invite` | **Todo** |
| `signup_team` | **Out**: legacy whole-team registration, superseded by the team system |

### Teams

| Endpoint | Status |
|---|---|
| `create_team`, `rename_team`, `disband_team`, `leave_team` | **Done** |
| `request_join`, `cancel_join`, `respond_join` | **Done** |
| `invite_to_team`, `respond_invite` | **Done** |
| `set_captain`, `move_player` | **Done** |
| `cancel_invite`, `org_create_team` | **Todo** |

`join_team` is **Out** because the server refuses it: it answers "send a join
request, the captain approves it". Not a gap, a removed path, and the client
must not offer one.

`set_team_name` is **Out**: it belongs to the retired `premade` formation.

Building this turned up a bug in the offline fake: it handed every signup a
team of one, which is what hid the dead end. The server never does, so it no
longer does either, and a 2v2 is seeded so the whole conversation can be
exercised without a server.

### Play

| Endpoint | Status |
|---|---|
| `report_confirm` | **Done** |
| `report_submit` | **Out**: only the organiser records a result here, and it insists on one FAF replay id per game. Removed 2026-08-18 rather than left unreachable. `report_confirm` stays, because answering a report raised on the website is a different act from raising one |
| `report` (organiser) | **Partial**: scores, forfeits and an explicit winner override. Free-for-all lobbies are reported through `report_ffa` |
| `set_match_team` | **Todo** |
| `pick`, `undo_pick` | **Done** (2026-08-18) |
| `report_ffa` | **Done** (2026-08-18): a lobby is settled by its winners or by a points table, which the standings then sum |
| `veto_action`, `veto_setab`, `veto_undo` | **Done** (2026-08-18) |

### Maps

| Endpoint | Status |
|---|---|
| `pool_assign` | **Done**. The rounds no longer wait for the draw: `Tourney::round_plan` reads them off the bracket once it exists and projects them from the expected entrant count before that, which is when the map plan is actually made. Twin pinned, eight cases. A single control binds one pool to every round at once, which is what most tournaments want |
| `pool_save` | **Done** (2026-08-18): a pool editor with map selection, series length and the ban/pick order, refused against the twin of the service's own counting rules before it is sent |
| `map_save`, `map_publish`, `map_delete` | **Done** (2026-08-18). Maps are picked out of FAF's own vault, with search, previews, size and player count, and several at a time. Typing a name by hand stays, for a map that was never uploaded |
| `set_maps`, `copy_maps` | **Todo**: `set_maps` is the legacy per-round map list, superseded by pools |
| `pool_publish`, `pool_delete` | **Done** (2026-08-18) |
| `pool_copy_sequence` | **Todo**: copies one pool's order onto another |

### Organisers and content

| Endpoint | Status |
|---|---|
| `add_organizer`, `organizer_visibility` | **Done** (2026-08-18): add a co-organiser by FAF account, and show or hide one in the public list. Hiding changes the credit, not the rights |
| `remove_organizer` | **Out**: site-admin-only, same reason as `restore` above |
| `claim_organizer` | **Out**: it is authorised by the organiser link's token, which is a URL pasted into a browser. The client has nowhere to paste one |
| `news_post`, `news_delete` | **Done**: posting with an important flag, and taking a post down |
| `news_edit`, `news_read` | **Done** (2026-08-18): correcting a post, with an "edited" marker, and the per-account read marker behind the unread badge |
| `chat_mute`, `chat_delete` | **Done** (2026-08-18): both on the post that prompted them, and the silenced list with a way back in Manage |
| `chat_rooms`, `chat_read` | **Done**, and re-read every five seconds while a room is open. Silent: a poll that announced itself would blink the room out from under whoever is reading it |
| `!organizer`, `!roll` | **Done differently**: both are the service's, triggered by what is typed, so they need nothing from the client but the message. The composer names them in a tooltip. The website's bell button is not built |
| `add_desc_image`, `remove_desc_image` | **Todo** |
| `secrets` (admin, late-signup and streamer tokens) | **Out**: three tokens whose only use is a URL handed to somebody else, and the website already does that with the copy buttons and the wording that goes with them |

### Site-wide reads

| Endpoint | Status |
|---|---|
| `GET /api/host_status` | **Done** |
| `GET /api/articles` | **Done** |
| `GET /api/halloffame` | **Todo** |
| `GET /api/series`, `/api/series/{id}`, `set_series`, `qualifier_add`, `qualifier_remove` | **Done** (2026-08-18): file an event under a series, create and rename one, and link the events that feed it. Series and qualifiers are separate mechanisms and are drawn apart: a series is a browsing label, a qualifier sends invitations |
| `GET /api/my_tournaments` | **Todo** |
| `GET /api/my/pending` (invites awaiting you) | **Todo** |
| `POST /api/my/profile` (Discord handle), `my/dismiss_requests` | **Todo** |
| `editor_status`, `importer_status`, `*_request`, `admin_lookup`, `siteadmin/*`, `import_challonge` | **Out**: site administration |

## 3.05 The chat, checked against what the tournament team asked for

Checked 2026-08-18 against two requirements the tournament team stated directly, plus the
website's own room list.

| Asked for | Found |
|---|---|
| "Chats only get generated when the match is set, as in both teams are known" | **Already right.** `chatRoomsFor` decides it and the client renders what it is sent. Pinned with a test. The offline fake was wrong: it made a room for BYE matches and used the bare match id where the service uses `match:{id}` |
| "Chats get archived and no longer shown, or shown under Completed which you can expand and minimize, when a Match is done. Otherwise you will see too many, which was an issue at first and made it confusing" | **Was missing.** The codec read `id`, `label` and `unread` and dropped the rest, so a finished match's room stayed in the live list forever |
| "Chats are only shown to participants of the tourney" | **Already right**, service-side |
| The caster link | **Blocked, and possibly nothing to do.** `isStreamer` is token-based: the caster link is `streamerToken` in a URL, which the client has nowhere to put. If casters become an account role, `chatRoomsFor` sends them every room on their session alone and the client inherits it. `viewer.streamer` is already sent and still unread; that is the field to reach for when the role lands |
| Chats lock some days after the event | **Already right.** `chatLocked` is read, the composer closes and says why. Two days after the finish stamp |

Reading `done` brought back two more fields that had gone with it:

- **`mention`**: this account was named with `@` here. It replaces the unread count rather than
  sitting beside it, which is what makes it findable. Dropped, so being pinged was invisible.
- **`ping`**: somebody typed `!organizer` and no organiser has read it. Organiser-only.
  Dropped, so an organiser had no way to find the room asking for them.

**And one nobody had raised: the chat could send but not receive.** There was no polling
anywhere and the service has no push of any kind, so a message from anyone else never arrived
until the reader switched rooms and back. Writing worked, which is what had been tested. The
open room and the room list are now re-read every five seconds, silently, and the interval is
torn down when the section closes.

## 3.1 Three bugs the write paths were hiding

All three were the same shape, and it is worth naming because it will recur: **a key the
client sends but never reads.** The service treats a present key as an instruction, so a
field the client cannot see is a field it overwrites with a guess.

| Field | What it did |
|---|---|
| `signupMode` | Sent by `edit_info`, never parsed. `draftOf` filled it with `"open"`, so correcting a typo in an invite-only event's name reopened it to everyone |
| `seeding`, `maxTeams` | Sent by `edit_format` from a draft that reads neither. Saving a bracket-type change reset the seeding policy to `rating` and cleared the entrant cap |
| `ratingType` | Sent as `"global"` from the same hardcoded block as `signupMode` |

`signupMode` and `maxTeams` are read now; `seeding` and the best-of plan are not sent at all,
which is the other correct answer. The recorded-response tripwire has been tightened so this
class cannot recur: it used to count a field as covered when its name appeared *anywhere* in
the codec, which a request body satisfies. It now matches only a read rooted at the response
document, in all three of its directions.

## 4. Beyond the website

Things the client can do that a web page cannot, which is the reason for having
the tab at all rather than an embedded browser.

| | Status |
|---|---|
| Map previews from FAF's own vault, matched against hand-typed names | **Done** |
| Host a tournament match in the client's lobby, title prefilled | **Done** |
| Avatars, ratings and the player card on bracket rows | **Done** |
| A writable offline backend, so the whole flow is developable with no server | **Done** |
| One click to enter: already authenticated, no browser, no second login | **Done** |
| Desktop notification when your match becomes ready, check-in opens, or an opponent submits a score | **Todo** |
| Open a reported replay in the Replays tab from the bracket | **Todo** |
| Prefill the host dialog with the round's map pool, not just the title | **Todo** |
| Private message an opponent from the bracket | **Todo** |
| The tournament's chat as a channel in the Chat tab | **Todo** |

## 5. Order of work

Lifecycle first, then the parts that hang off it:

1. ~~**Teams**~~. Done.
2. ~~**Signup administration**~~. Done.
3. ~~**Seeding**~~. Done.
4. ~~**News**~~. Done.
5. ~~**Results**: forfeits, explicit winner, FFA, standings~~. Done.
6. ~~**The map database** and ban/pick sequences~~. Done.
7. ~~**Vetoes**, then the **captains draft**~~. Done.
8. ~~**Series**, the **audit log**, chat moderation~~. Done. **Hall of Fame** is
   the one left in this line.
9. The client-only wins in §4: notifications, replay links, pool prefill.

What is left after this is listed in section 13 of `tourney-audit.md`. It is
no longer a list of missing mechanisms: it is a Hall of Fame page, a series
browsing page, description images, and a handful of conveniences for reusing one
event's work in another.
