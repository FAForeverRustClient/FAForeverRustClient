# Migration: Challonge out, faf-tournaments in

The record of replacing the Challonge bridge with FAF's own tournament service.
Kept after the fact rather than deleted: it says what the service actually
does, which decisions were deliberate, and what has still never been run
against a live instance.

Read [tourney-audit.md](tourney-audit.md) first: it is
measured against `server.js` rather than recalled, and it says which of the
decisions below no longer hold. `faf-tournaments-api.md` was deleted; it was a
retelling and was wrong in several places that decisions had been built on.

## Decisions this plan rests on

- **Replace, not run alongside.** The tournament team is moving off Challonge;
  two sources in one tab would only confuse. The Challonge codec, port, infra
  and the forum signup parser all come out.
- ~~**The client is for participants, not administrators.**~~ **Reversed
  2026-08-17.** The scope is now the website's whole feature set, built in
  lifecycle order. Creating, entrant administration, teams, seeding, divisions
  and news all live in the tab. What is left is tracked in
  [tourney-features.md](tourney-features.md).
- **The forum workflow is obsolete.** Signups happen on the website now, so
  `protocol/signups.rs` and the import/export dialogs are deleted rather than
  ported. They solved a problem Challonge created.

## Done

The migration is complete. Challonge is gone from the tree; the tab is built on
`faf-tournaments`. Every gate is green.

- `state/tourney.rs`: the model *and* the slice. String ids, teams, map pools,
  rating gates, `may_report` / `may_confirm` / `may_sign_up`, `display_name`,
  `match_vault_map`, plus `TourneyState`, its commands, events and reducer.
- `protocol/tourney.rs`: the codec for `publicView`, the chat rooms, the posts
  and the articles. `protocol/markup.rs` is the old `protocol/tournaments.rs`,
  renamed: it was never Challonge-specific, and four services hand this client
  somebody else's HTML.
- `ports/tourney.rs`, `infra/tourney.rs`, `infra/tourney_fake.rs`: the boundary,
  the client, and a writable in-memory backend with a four-team bracket that
  really advances along `winner_to`.
- `services/tourney.rs`: `SerialMutation` for writes, `LatestRequest` for detail
  and chat reads, a reload after every write.
- `tests/tourney.rs`, two conformance cases, and the frontend twin in
  `store/reducers/tourney.ts`.
- The tab: list, then Overview / Rules / Entrants / Bracket / Chat / Manage.
  Bracket connectors are drawn from `winnerTo` rather than from column geometry.
  The report dialog asks for one replay id per new game, because the server
  refuses anything else. Manage holds map-pool assignment and a link out.

### What reading `server.js` changed

The model and codec were first written from the shape of `publicView` alone.
Reading the handlers corrected six things, each of which would have been a bug
against a live server:

1. **Match status** is `waiting` / `ready` / `live` / `bye` / `done`. There is no
   "reported" status: a submitted score is a separate `pendingReport` field, and
   the bracket has not moved while it sits there. `live` means a series at 1-1,
   which is still reportable, so reading it as "not ready" would take the report
   button away mid-series.
2. **Brackets** are `wb` / `lb` / `gf` / `sw` / `ffa`. Swiss and free-for-all are
   real values, not a fallback to the winners bracket.
3. **Dates come in two shapes.** `createdAt`, `signedAt` and `checkInDeadline`
   are millisecond stamps; `eventDate`, `signupOpensAt` and `signupClosesAt` are
   ISO strings normalised by `cleanDate`, sometimes bare `YYYY-MM-DD`. Reading
   only numbers would leave every event without the one date players look for.
4. **`view.viewer`** names this account's `signedUpPlayerId`, `memberTeamId` and
   whether it organises the event. Taken as given rather than re-derived from the
   FAF id: the server authorises every write against the same answer.
5. **The list endpoint** sends `players` and `teams` as *counts*, not arrays.
6. **Reporting needs replay ids**, exactly one per newly reported game, or the
   whole submission is refused. That is what makes a bracket auditable, so the
   client asks for them rather than working around the rule.

Statuses are `draft` / `signup` / `drafted` / `running` / `finished`.
`pool_assign` keys are `{bracket}:{round}` (`wb:1`) or `match:{id}`.

### Deleted with the Challonge path

`protocol/challonge.rs`, `protocol/signups.rs`, `state/tournaments.rs`,
`ports/tournaments.rs`, `infra/tournaments.rs`, `infra/tournaments_fake.rs`,
`services/tournaments.rs`, `tests/tournaments.rs`, the `Tournaments` slice from
`AppState` / `AppCommand` / `AppEvent`, `FAF_CHALLONGE_DIRECT` and
`CHALLONGE_API_KEY`, and on the frontend `SignupImport`, `TournamentForm`,
`ParticipantsPanel`, `EntrantPicker`, `DangerZone`, `tournamentStatus.ts`,
`store/reducers/tournaments.ts`, and the now-unused `shared/roles.ts`,
`shared/clipboard.ts` and `shared/playerActions.ts`.

`faf_domain::state::Player::is_tournament_director` and `FAF_FAKE_ROLES` stay:
the FAF role is real, it simply no longer gates anything here. Whether an
account organises *this* event is the tournament service's own answer, in
`viewer.organiser`.

## Testing against a real server

**The Bearer blocker is gone.** `resolveBearerSession` is deployed and live:
`https://tournaments.doodlepros.com` answers `GET /api/tournaments` and
validates `Authorization: Bearer <faf access token>` against FAF's own `/me`.
No client change is needed for any of it.

The reason nobody has seen it work is `.claude/launch.json`, which pinned
`FAF_FAKE_AUTH=1`. That picks `fake_ports()`, so the tab talked to
`FakeTourney` and the real client was never constructed. Two configurations
now sit beside it.

**Local first.** In a checkout of `faf-tournaments`:

```
node server.js
```

Then run the client with `TOURNEY_API_BASE=http://localhost:8090` and log in
with FAF normally. That is real HTTP, the real codec and a real identity
against a `data/db.json` of your own. Worth knowing: `resolveBearerSession`
does not depend on `FAF_OAUTH_ON`, so a local instance needs no OAuth
configuration at all, and with OAuth unconfigured `host_status` answers
`allowed: 1`, so creating tournaments works without host approval.

**Live second.** The same, without `TOURNEY_API_BASE`. Those are real
tournaments: reads are free, but creating, archiving and reporting are not a
sandbox.

Still unverified either way: the map preview field name in `publicMapView`.
The codec accepts `imageUrl` / `image` / `url` / `preview`. Mostly moot now
that previews come from FAF's vault, but it is the fallback for maps never
uploaded there.

## Gates

`cargo test --workspace`, `cargo clippy --all-targets -D warnings`,
`pnpm run bindings` (drift check), `pnpm run typecheck`, `pnpm run lint`,
`pnpm run architecture`, `pnpm test`.

## After the migration: building out the website's feature set

The client was scoped to a participant's view. That decision was reversed: it
now builds toward what `faf-tournaments`' own website does, in lifecycle order.

### Done

- **Creating and configuring an event.** `POST /api/tournaments`, `edit_info`,
  `publish`, `phase` and `delete`, behind a `TourneyDraft` the form validates
  before sending. The create button is gated on `GET /api/host_status`, because
  hosting is approval-only and an ungated button answers "not approved yet".
- **The lifecycle steps**, each offered only from the status the server takes it
  from: close signups and form teams, draw the bracket, reopen signups.
  `TourneyPhase::is_legal_from` is the gate, mirrored in `ManagePanel`.
- **Two bugs found by running the client.** Entering one tournament appeared to
  enter the next one clicked: the list row rendered an "Entered" badge from
  viewer data `GET /api/tournaments` never sends, so it appeared the moment a
  row was opened, and the fake seeded the only other running event with the
  viewer already in it. Both fixed, with a regression test and a third fake
  event nobody is in. Check-in was also offered during signups, where the
  server refuses it.

### Deliberately not in the create form

The best-of plan, the veto configuration, the map database, series and
qualifiers. The server defaults all of them, and those defaults are the
tournament team's own. Asking an organiser for six best-of numbers before their
event has a single entrant is the wrong first question.

### Next, in order

1. **Entrants and teams.** The dead end a player hits today: after entering a
   team event there is nowhere to form or join one. `create_team`, `join_team`,
   `request_join`, `respond_join`, `invite_to_team`, `respond_invite`,
   `leave_team`, `disband_team`, plus the organiser's `org_add_player`,
   `remove`, `edit_player` and `move_player`.
2. **Seeding.** `reseed` by hand or at random, divisions.
3. **Results beyond the player path.** Organiser corrections, forfeits, an
   explicit winner, FFA by points or by winners, and standings.

Then the parts that are not the lifecycle: the map database and ban/pick
sequences, vetoes, news, series, the hall of fame, and the admin console.
