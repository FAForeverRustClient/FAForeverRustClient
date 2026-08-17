# faf-tournaments: the API surface the client targets

Reference for replacing the Challonge bridge with
[FAForeverRustClient/faf-tournaments](https://github.com/FAForeverRustClient/faf-tournaments)
(forked from Nuggets75/faf-tourney). Read out of `server.js` at fork time; anything marked
**assumed** was not confirmed against a running instance.

Written down because `server.js` is a 4858-line monolith with over a hundred routes, and
re-deriving this every session is not a good use of anyone's time. When the server changes,
change this file with it.

## Shape of the API

Plain Node HTTP, no framework. Two prefixes, dispatched in `handleAPI` / `handleAuth`:

- `/api/...`: everything the client needs
- `/auth/...`: the browser OAuth flow (`/auth/me`, `/auth/login`, `/auth/callback`, `/auth/logout`)

Per-tournament routes are `/api/t/{id}/{action}`, almost all `POST`. Path segments are split
manually (`url.pathname.split('/').filter(Boolean)`), so there is no route table to read: the
list below was extracted from the `sub === '...'` chain.

## Authentication: the one blocking gap

`currentSession(req)` reads **only** the `faf_sid` cookie, set after the browser OAuth
redirect through a confidential client. No `Authorization` header is examined anywhere.

The desktop client is a public PKCE client holding a FAF access token and cannot obtain that
cookie. **Until the server accepts a Bearer token, the client cannot even read.** The agreed
fix is a second path in `currentSession` that validates a Bearer token against
`https://api.faforever.com/me` and builds the same session object, cached in memory for ~60s.
Roles are unaffected: `isSiteAdmin` / `isDirector` / `canHost` keep reading `db.siteAdmins`
and friends by `fafId`.

Session object: `{ fafId, fafName, exp, faf: { enc, exp } }`.

## Reads

| Route | Purpose |
|---|---|
| `GET /api/tournaments` | The list. |
| `GET /api/t/{id}` | One tournament, as `publicView(t)` (below). Accepts `?token=` for captain/streamer links. |
| `GET /api/my_tournaments` | Tournaments the caller organises. |
| `GET /api/series`, `GET /api/series/{id}` | Series and their editions. |
| `GET /api/halloffame`, `GET /api/articles` | Standalone pages. |
| `GET /api/host_status`, `editor_status`, `importer_status` | Whether the caller may host / edit / import. |
| `GET /api/my/pending` | Invites and join requests awaiting the caller. |
| `GET /api/t/{id}/chat_rooms`, `chat_read`, `secrets` | Chat, and organiser-only values. |

### `publicView(t)`

The whole tournament in one object. Far richer than Challonge's three types, and it holds
exactly what Challonge could not:

- **Identity/《meta》**: `id`, `name`, `description`, `rewards`, `prize`, `sponsors`,
  `category` (`official` | `community`), `status`, `createdAt`, `eventDate`, `published`,
  `publishAt`, `archived`, `abandoned`, `imported`
- **Format**: `competition` (`team` | `ffa`), `formation` (`solo` | `open` | `draft`),
  `teamSize` (1–6), `bracketType` (`single` | `double` | `swiss`), `plan` (best-of per round
  stage), `perRoundBo`, `rounds`, `divisions`, `seeding`, `draftOrder`, `ffaCfg`
- **Maps**: `mapDb` (the tournament's own map database, with images), `mapPools`
  (`{ id, name, mapIds, sequence, bo }`), `poolAssign` (pool per round), `maps`
- **People**: `players`, `teams` (`{ id, name, seed, captainId, playerIds, division,
  checkedIn, joinRequests, invites, eliminated, finalRank }`), `subs`, `pendingCaptains`,
  `organizersPublic` (name + discord)
- **Play**: `matches`, `draft`, `veto` (`{ enabled, mode }`), `championTeamId`
- **Windows**: `signupOpensAt`, `signupClosesAt`, `checkInOpensAt`, `checkInDeadline`,
  `chatLockAt`, `chatLocked`
- **Gates**: `minRating`, `maxRating`, `maxTeamRating`, `ratingCap`, `minTeams`, `maxTeams`,
  `signupMode`, `playerReporting`
- **Series**: `seriesId`, `seriesName`, `seriesColor`, `qualifiers`, `feedsInto`

Fields are trimmed by role: `createdByName` is removed for non-organisers, `organizers` is
added for organisers.

## Writes (all `POST` unless noted)

Grouped by what they are for; the full chain is in `handleAPI`.

- **Lifecycle**: `/api/tournaments` (create), `/api/t/{id}/publish`, `phase`, `delete`,
  `abandon`, `restore`, `edit_date`, `edit_info`, `edit_format`, `set_category`, `reseed`,
  `split_divisions`, `set_division`
- **Signup**: `signup`, `signup_team`, `remove`, `respond_signup`, `invite_player`,
  `uninvite_player`, `decline_invite`, `org_add_player`, `edit_player`, `replace_player`,
  `faf_lookup`
- **Teams**: `create_team`, `org_create_team`, `join_team`, `request_join`, `cancel_join`,
  `respond_join`, `invite_to_team`, `cancel_invite`, `respond_invite`, `leave_team`,
  `disband_team`, `rename_team`, `set_team_name`, `set_captain`, `move_player`,
  `checkin_team`, `set_match_team`
- **Maps**: `map_save`, `map_publish`, `map_delete`, `set_maps`, `copy_maps`, `pool_save`,
  `pool_publish`, `pool_delete`, `pool_assign`, `pool_copy_sequence`
- **Play**: `report_submit` (a player reports), `report_confirm` (the other side agrees),
  `report` (an organiser decides), `pick` / `undo_pick` (draft and veto),
  `set_round_bo`, `set_plan_round_bo`
- **Organisers**: `add_organizer`, `remove_organizer`, `claim_organizer`,
  `organizer_visibility`
- **Content**: `news_post`, `news_edit`, `news_delete`, `news_read`, `chat_post`,
  `chat_mute`, `chat_delete`, `add_desc_image`, `remove_desc_image`
- **Site**: `/api/siteadmin`, `/api/siteadmin/{action}`, `/api/host_request`,
  `/api/editor_request`, `/api/importer_request`, `/api/admin_lookup`,
  `/api/import_challonge`, `/api/series`, `/api/my/profile`, `/api/my/dismiss_requests`

## Inner shapes

`publicView` passes `players`, `matches` and `draft` through unchanged, so their shape comes
from where the server builds them.

**Player** (`server.js`, signup handler):

```js
{ id: 'p1a2b', name, rating, ratingActual, fafId, manual, late,
  teamName, teamId, signedAt, pending }
```

`fafId` is the FAF account, already first-class, with no `misc` smuggling needed. `rating` is the
value fetched as of the tournament's `ratingDate`; `ratingActual` is the uncapped one before
`applyRatingCap`.

**Match** (`lib/match.js`, `newMatch`):

```js
{ id: 'm1a2b', bracket, round, index, bo, hcap, division,
  team1, team2, score1, score2,
  status, winner, loser, winnerTo, loserTo }
```

### Two consequences for the port

1. **Every id is a string**, not an integer: `p1a2b`, `m1a2b`, and the same for teams and
   pools. The Challonge model used `i32` throughout, and so does the current
   `faf_domain::state::tournaments`. All of it has to become `String`. This is the single
   most invasive difference and it touches the slice, the commands, the events and the
   frontend twins.

2. **The bracket is explicitly linked.** `winnerTo` / `loserTo` are `{ id, slot }`, so a
   match names where its winner and loser go. Challonge left this to be inferred from round
   numbers, which is why the connector lines had to be guessed at from column geometry. With
   an explicit graph the bracket can be drawn from the real edges, and `bracket` (rather than
   a negative round number) separates winners from losers.

Also worth noting: `status` is per match (`waiting`, …), separate from the tournament's own
`status`/`phase`.

## What the client needs first

A vertical slice does not need most of the above. The smallest set that gets a tournament
from creation to a reported result:

`GET /api/tournaments` → `GET /api/t/{id}` → `POST /api/tournaments` →
`POST /api/t/{id}/signup` (or `org_add_player`) → `POST /api/t/{id}/phase` →
`POST /api/t/{id}/report`.

Map pools (`pool_save`, `pool_assign`, `map_save`) and teams (`create_team`, `join_team`)
come second: they are what Challonge could not do, and the reason for the move.

## Notes and open questions

- **Assumed**: the exact request bodies. Only `POST /api/tournaments` was read in full
  (`name`, `category`, `competition`, `teamSize`, `formation`, `bracketType`, `draftOrder`,
  `plan`). Everything else needs its handler read before the port method is written.
- `playerReporting` decides whether players may report results themselves
  (`report_submit`/`report_confirm`) or only organisers (`report`). The client should honour
  it rather than always offering the organiser path.
- `status` and `phase` are the server's own lifecycle, not Challonge's `pending`/`underway`.
  The existing `TournamentProgress` enum has to be re-derived from it.
- Booleans cross the wire as `0`/`1`, not `true`/`false`. The codec has to be lenient about
  this, as the Challonge one already is about strings-vs-numbers.
