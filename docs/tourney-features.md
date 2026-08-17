# The tournament tab: every feature, and where it stands

Written by reading `server.js` (109 per-tournament actions, 16 top-level routes)
and the website's own `public/app*.js` (~8,500 lines). The point of the list is
that "build the rest of the website" is otherwise unanswerable: there is no
schema, no API document, and no feature list on the far side.

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
| `/series` and `/series/{id}` | A section, or a filter on the list | **Todo** |
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
| News | **Done** | Posting, deleting and an important flag. `news_edit` and the read marker are not there |
| Entrants | **Done** | Shows people, teams, seeds, check-in and placings |
| Teams | **Done** | Form one, ask to join, answer requests, invite, leave, rename, disband. Only shown where there are teams to form |
| Bracket | **Done** | Drawn from `winnerTo`/`loserTo`. Swiss and FFA rounds render as one column but have no standings table |
| Standings | **Todo** | Swiss tables, FFA points, imported group tables, final placements |
| Chat | **Done** | Moderation (`chat_mute`, `chat_delete`), `@mention` highlighting, organiser ping badge |
| Maps | **Partial** | Pools can be assigned and previewed. The map database itself (`map_save`, `map_publish`, `map_delete`, `copy_maps`) and the ban/pick sequence editor are not there |
| Vetoes | **Todo** | `veto_action`, `veto_setab`, `veto_undo`, and the veto state display |
| Draft | **Todo** | `pick`, `undo_pick`, the captain queue and the draft board |
| Manage | **Done** | Settings, lifecycle, entrant administration, invitations, seeding, divisions, map pools, archive |
| Audit log | **Todo** | `tlog`, organiser-only |

## 3. Endpoints, grouped by what they are for

### Lifecycle

| Endpoint | Status |
|---|---|
| `POST /api/tournaments` | **Done** |
| `publish` | **Done** |
| `phase` → `form_teams`, `start_bracket`, `reopen_signups` | **Done** |
| `phase` → `set_captains`, `start_draft` | **Todo** (needs the draft) |
| `delete` (archives for a non-admin) | **Done** |
| `edit_info` | **Partial**: name, description, dates, rating gate, signup mode, player reporting. Missing rewards, prize, sponsors, streams, lobby options, mods, check-in deadline, veto, rating date |
| `reseed`, `split_divisions`, `set_division` | **Done** |
| `edit_date`, `edit_format`, `set_category` | **Todo** |
| `abandon`, `restore` | **Todo** |
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
| `edit_player`, `replace_player`, `faf_lookup`, `decline_invite` | **Todo** |
| `signup_team` | **Out**: legacy whole-team registration, superseded by the team system |

### Teams

| Endpoint | Status |
|---|---|
| `create_team`, `rename_team`, `disband_team`, `leave_team` | **Done** |
| `request_join`, `cancel_join`, `respond_join` | **Done** |
| `invite_to_team`, `respond_invite` | **Done** |
| `cancel_invite`, `set_captain`, `org_create_team`, `move_player` | **Todo** |

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
| `report_submit`, `report_confirm` | **Done** |
| `report` (organiser) | **Partial**: scores only. No forfeit, no explicit winner override, no FFA |
| `set_match_team` | **Todo** |
| `pick`, `undo_pick` | **Todo** (draft and veto) |

### Maps

| Endpoint | Status |
|---|---|
| `pool_assign`, `pool_save` | **Done** |
| `map_save`, `map_publish`, `map_delete`, `set_maps`, `copy_maps` | **Todo** |
| `pool_publish`, `pool_delete`, `pool_copy_sequence` | **Todo** |

### Organisers and content

| Endpoint | Status |
|---|---|
| `add_organizer`, `remove_organizer`, `claim_organizer`, `organizer_visibility` | **Todo** |
| `news_*` | **Todo** |
| `chat_mute`, `chat_delete` | **Todo** |
| `add_desc_image`, `remove_desc_image` | **Todo** |
| `secrets` (admin, late-signup and streamer tokens) | **Todo** |

### Site-wide reads

| Endpoint | Status |
|---|---|
| `GET /api/host_status` | **Done** |
| `GET /api/articles` | **Done** |
| `GET /api/halloffame` | **Todo** |
| `GET /api/series`, `/api/series/{id}`, `set_series`, `qualifier_add`, `qualifier_remove` | **Todo** |
| `GET /api/my_tournaments` | **Todo** |
| `GET /api/my/pending` (invites awaiting you) | **Todo** |
| `POST /api/my/profile` (Discord handle), `my/dismiss_requests` | **Todo** |
| `editor_status`, `importer_status`, `*_request`, `admin_lookup`, `siteadmin/*`, `import_challonge` | **Out**: site administration |

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
5. **Results**: forfeits, explicit winner, FFA, standings.
6. **The map database** and ban/pick sequences.
7. **Vetoes**, then the **captains draft**.
8. **Series**, **Hall of Fame**, the **audit log**, chat moderation.
9. The client-only wins in §4: notifications, replay links, pool prefill.
