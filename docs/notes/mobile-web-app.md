# A mobile web client

Status: proposal, September 2026. Nothing here is built yet.

The goal is a phone-shaped FAF client that runs in a mobile browser and is
installable as a PWA: the things a player wants while away from their PC. News,
chat, a read-only view of the open lobbies, maps, mods, the leaderboard,
tournaments, events, training, the changelog and the unit database. No game
launch, no ICE, no downloads, no vault installs, no replays: nothing that needs
a Forged Alliance install underneath it.

This document exists because the interesting part of the work is not the UI. It
is which half of the client can run inside a browser at all, and that half is
smaller than it looks.

**A website, not a native app**, and the question is less close than it sounds.
The backend is required either way: the OAuth code exchange, the IRC token and
the machine proof are all impossible in a client, whether that client is Safari
or Swift. A native app would therefore need exactly this same server *plus* a
third UI to maintain, a store review for every bugfix and an Apple developer
account. The PWA instead inherits `design-system`, `store` and `i18n` from the
submodule. The usual argument for going native is push notifications, and
section 6 explains why that argument does not apply here.

Three things are settled, and the rest of the document is written around them:

- **It lives in its own repository.** Section 2 is about how it still shares one
  core with this one.
- **`faf-uid` runs on Nuggets' server**, one instance serving every player's
  lobby login, while each player connects with their own token. Section 5, and
  the service contract in `faf-uid-service.md`.
- **A working OAuth2 registration is the blocker.** Everything else can be
  built; almost nothing can be tested against production until it exists.
  Section 4.

---

## 1. What a browser can and cannot reach

Measured against production on 14 September 2026, not inferred from the code.

| Endpoint | Result | Consequence |
|---|---|---|
| `api.faforever.com` preflight | `access-control-allow-origin: *`, `access-control-allow-headers: authorization` | A web page may call the FAF API directly, with a bearer token. |
| `api.faforever.com` without a token | `401`, `www-authenticate: Bearer` | Every data tab needs a logged-in user. There is no anonymous read any more. |
| `user.faforever.com/irc/ergochat/token` preflight | no CORS headers at all | The IRC token cannot be fetched by a page. It needs a server of ours in front of it. |
| `hydra.faforever.com/oauth2/token` preflight | no CORS headers | The PKCE code exchange cannot happen in the browser either. |
| `/oauth2/auth` with an `https` redirect on the desktop client id | `invalid_request`: the redirect "does not match any of the OAuth 2.0 Client's pre-registered redirect urls" | We cannot reuse the desktop client id for a web redirect. |
| `/oauth2/device/auth` on the desktop client id | `invalid_grant`: the client "does not have the device_code grant" | The device flow is not an escape hatch either. |
| `www.faforever.com/newshub`, `faforever.github.io/etfreeman-db` | no `X-Frame-Options`, no frame CSP | News and Units stay what they already are in the desktop client: embedded web pages. |

The three missing-CORS rows all say the same thing, and it is not a problem: we
are building a server anyway. Nothing in the browser talks to Hydra, to the IRC
token endpoint, or to the lobby. The phone talks to us, and we talk to FAF.

---

## 2. Two repositories, one core

The mobile client is its own repository. That is a decision about deployment and
release cadence, not about the code: this thing can be down, it ships whenever a
deploy happens rather than whenever a desktop release is cut, it carries a web
server's dependencies and a web server's security surface, and none of that
belongs in the tree that produces a desktop binary.

What it is emphatically not is a second implementation. The reason is worth
stating once, because a fresh repository invites exactly that mistake.

**The rejected option.** A standalone SPA that talks to `api.faforever.com`
directly looks lighter and is a trap. What the mobile app needs is not "some
JSON from the API": it is the query building, the paging around `page[size]`
being clamped at 100, the post-filters for the three things the API cannot
answer, the leaderboard/league distinction, the catalogue parsing, and above all
the IRC client and the lobby protocol. All of that exists once, in Rust, tested.
Rewriting it in TypeScript means maintaining two of everything, and it *still*
needs a server for OAuth, the IRC token and the UID. A separate repo does not
change that arithmetic; it only makes it easier to pretend otherwise.

So the new repository holds the server and the phone shell, and consumes this
one.

### The seam

One pin for everything: this repository as a git submodule at `vendor/client`,
and the new repository's Cargo manifest reaching into it by path.

```
faf-mobile/                     (new repo)
  Cargo.toml                    faf-app = { path = "vendor/client/crates/faf-app" }
  crates/faf-mobile/            axum: /command, /snapshot, /events
  ui/                           the phone shell, Vite
  vendor/client/                submodule, pinned at a commit of this repo
```

Three consequences, all of them good:

- **Rust.** `publish = false` blocks crates.io, not a path or git dependency, so
  no crate here has to be restructured or released. Cargo resolves the vendored
  workspace exactly as it resolves it in place.
- **Bindings cannot drift.** The mobile repo does not copy `bindings.ts`; it
  *generates* it, running `cargo run -p faf-ipc --bin export-bindings` against
  the same pinned checkout it compiles against. The drift gate that CI runs here
  is the same gate there, for the same reason.
- **Shared frontend.** `design-system`, `store`, `i18n` and `shared` are aliased
  out of `vendor/client/ui/src`, so the phone shell inherits the tokens, the
  mirror and the translation catalogues rather than forking them.

Updating the pin is one deliberate pull request in the mobile repo. This
repository never waits on it and never builds it; `faf-domain` and `faf-app`
simply become an interface with a downstream consumer, which the conformance
fixture and the bindings gate already describe better than most published crates
describe themselves.

Submodules are forgotten at clone time by everyone at least once. A preinstall
check that fails loudly when `vendor/client` is empty costs ten lines, and this
repository already has the pattern in `scripts/require-pnpm.mjs`.

### How updates reach the phone

Not automatically, and that is the point. The web app consumes a commit, not a
release, so nothing that lands here reaches a phone until somebody moves the pin
and deploys. If the deployment followed `develop`, a commit here could break a
running app for real players with nobody noticing.

What a pin move then brings across, in three tiers:

- **Complete, for free.** Everything below the UI: new state, events, commands
  and reducer rules, new and fixed service logic in `faf-app`, the regenerated
  bindings, and new strings in the shared catalogues. A new API field or filter
  is simply there.
- **As building blocks.** New design-system components, and the
  presentation-free feature logic: today 53 plain `.ts` modules under
  `ui/src/features` against 188 `.tsx` components, with names like
  `messageFilters`, `friendPresence`, `ratingRows`, `eventPresentation`,
  `calendarGrid`. Importable; somebody still has to place them.
- **Not at all.** The 188 views. Desktop layout is desktop layout.

So a feature usually arrives on the phone as *the data and the rules are already
here, someone writes the screen*. That ratio is ours to influence: every time a
feature's logic goes into a `.ts` beside the component rather than inside the
`.tsx`, the phone inherits more. Worth making the house rule once a second
consumer exists.

Two things this does not promise. A feature whose point is a desktop capability
(replay analysis, the map generator, game folders, the updater) never arrives,
because its ports are stubs. And a pin move can *fail*: a new service reaching
for a stubbed port stops the mobile build compiling. Discovered at pin time,
that is months of changes at once. So the mobile repo should run a **nightly CI
build against `develop` that does not deploy**, and let the breakage surface on
the day it is introduced, while someone still remembers why.

The reverse direction has no shortcut: shared code cannot be fixed from the
mobile repo. A fix to `faf-app` happens here, then the pin moves. That is the
price of one core instead of two.

### What we would change here first

Two small pieces of preparatory work in *this* repository, both of which stand
on their own merits:

1. **Feature-gate the desktop-only dependencies of `faf-app`.** `keyring`
   (`infra/oauth.rs`, `infra/guides.rs`), `open` (`infra/oauth.rs`) and
   `directories` (`infra/paths.rs` and friends) are meaningless on a headless
   server: there is no browser to open, no user session bus to hold a secret,
   and no per-user home directory that means anything. Today they are
   unconditional, so a Linux server image would drag `libdbus`/secret-service in
   to link code it can never call. Default features keep the desktop build
   byte-for-byte what it is; the server builds with `--no-default-features` plus
   what it needs.
2. **A second auth adapter, not a second auth.** The desktop flow binds a
   loopback listener, opens a browser and stores tokens in the keyring. The web
   flow redirects the phone to Hydra and stores tokens in the session registry.
   `AuthPort` already exists, so this is a new implementation behind an existing
   trait. `FAF_OAUTH_CLIENT_ID` and `FAF_OAUTH_SCOPES` are already environment
   overrides (`infra/oauth.rs`), so the mobile client id needs no code change at
   all.

---

## 3. The shape of the server

A new binary crate builds `App::new(version, ports)` per logged-in session with
a mobile port set, and speaks the same revisioned event stream to the phone that
`src-tauri` speaks to the desktop webview. The architecture was already built
for this: `ui/src/ipc/client.ts` is the single seam the whole frontend goes
through, `RevisionedMirror` already handles a lossy ordered channel with
snapshot recovery, and `faf-app/src/infra/mod.rs` already has two port sets
(`fake_ports`, `real_ports`), so a third is a known move rather than a new idea.

```
 phone browser                         our server                    FAF
+---------------+   POST /command   +-----------------+
|  React shell  | ----------------> | SessionRegistry |
|  store mirror |                   |   one App per   | --- api.faforever.com
|               | <---------------- |   logged-in     | --- chat.faforever.com (IRC/WS)
+---------------+   WS /events      |   session       | --- ws.faforever.com
                    (revisioned     +-----------------+     (that player's own
                     AppEvent)              |                lobby session)
                                            |
                                    POST /uid { session }
                                            |
                                     +--------------+
                                     | faf-uid      |  Nuggets' server
                                     | service      |
                                     +--------------+
```

1. **`crates/faf-mobile` (axum binary).** `POST /command` takes an `AppCommand`,
   `GET /snapshot` returns a `VersionedSnapshot`, `GET /events` is a WebSocket
   carrying the same `FrontendMessage` the Tauri channel carries today. No new
   contract: the generated bindings already describe all three.
2. **A session registry.** One `App` plus `AppLoop` per logged-in user, keyed by
   an HttpOnly session cookie, evicted when idle. The refresh token stays on the
   server and never reaches the browser.
3. **`mobile_ports()`.** Real adapters for auth, maps, mods, leaderboard,
   player_card, tourney, events, training, guides, changelog, reviews, streams,
   clan; an in-memory settings port; inert stubs for paths, process, ice,
   updater, replay, map_generator, uploads, client_update, galactic_war,
   tutorials. The mobile build is defined by which ports it refuses to wire.
4. **A lobby session per player**, opened lazily and with the player's own
   token, taking its `unique_id` from the shared `faf-uid` service rather than
   from a local binary. See section 5.
5. **The phone shell.** A bottom tab bar, stacked detail views, sheets. Its own
   Vite app in the mobile repo, sharing the store, the design system, the
   catalogues and the generated bindings through the submodule.

`faf-domain` does not change. The reducer, the events, the commands and the
conformance fixture are shared, so a fix to a slice lands in both clients at
once.

---

## 4. Login, which is the one real blocker

FAF has to register an OAuth client for this app. Until that exists, nothing
that reads the API can be tested against production, which is most of the app.
This is the same shape of external dependency as the Discord token for the
events calendar and the Twitch credentials for FAF Live: work that is finished
and inert until someone with FAF operations access acts.

The ask is smaller than the earlier draft of this document assumed. Because the
browser never speaks to Hydra (our server does the whole code exchange), this
does not need to be a public PKCE client. It is an ordinary server-side web
application registration:

- **Type:** confidential client, authorization code grant. PKCE on top is free
  and we should send it regardless.
- **Redirect URI:** `https://<our-domain>/auth/callback`, one value, decided
  once. The desktop client's loopback redirect stays exactly as it is.
- **Scopes:** `openid offline public_profile`. The desktop client also asks for
  `upload_map upload_mod`, which a phone has no use for, and `lobby`, which only
  the feed account of section 5 needs.
- **Secret:** held by the server, never shipped to the phone.

The host and domain have to be settled before this can be asked for, because the
redirect URI is part of the question.

---

## 5. The lobby: one `faf-uid`, many accounts

**Decided.** Every player's phone opens its own lobby session, with that
player's own token. There is no service account and no shared feed. What is
shared is the machine proof, and only the machine proof: one `faf-uid` instance,
on Nuggets' server, serving every mobile login.

The handshake is `GET {api}/lobby/access` with a bearer token, which returns a
one-time verified `wss://…/?verify=…` URL, then `ask_session` / `session`, then
`auth { token, unique_id, session }`. `unique_id` is the output of FAF's
`faf-uid` binary (`github.com/FAForever/uid`, pinned with its SHA-256 in
`scripts/ensure-faf-uid.mjs`) run against that session id. A web page cannot
produce it; a server can. The contract for the service that does is in
`docs/notes/faf-uid-service.md`.

### Why not a shared read-only feed

An earlier draft of this document proposed one service-account connection
broadcast to every phone. It is wrong, and the reason is in the server.

`broadcast_service.py:108` sends a `game_info` to a connection only when
`game.is_visible_to_player(conn.player)`, and `games/game.py:892-915` is that
predicate: a `FRIENDS` lobby reaches only the host's friends, the host's foes
never see the game at all, and `enforce_rating_range` hides games whose
displayed rating range excludes the viewer. The list is therefore *per player*.
A shared connection would not show every phone the same list: it would show
every phone **a stranger's list**, wrong in three systematic ways. The phone is
for players who want to see what they could join. That has to be their own view.

### Why one proof for many accounts works

`lobbyconnection.py:722` calls `check_policy_conformity(player_id, unique_id,
session, ignore_result=True)`. The policy service is told that the second
account carries the same hash as the first, and almost certainly answers
`already_associated`, and the answer is discarded, so the login proceeds. The
comment above the call says why: game ownership is verified separately, so the
policy check is informational for now.

So this works today, without a trick. It also rests entirely on one keyword
argument. Flipping `ignore_result` back turns `already_associated` into the
fatal "your computer is already associated with another FAF account" wall
(`lobbyconnection.py:601`) for every mobile user at once, and `fraudulent` into
an automatic permanent global ban. That is why this is asked about rather than
quietly relied on: not because it is a trick, but because the thing holding it
up should know it is holding something up.

### The kick, and what we do about it

`lobbyconnection.py:745`: a second login on one account signs the first out with
`fatal=True, style="kick"`. The phone connecting means the desktop client is
signed out. **This is accepted**, on the maintainer's call, but it is worse
than a cosmetic disconnect, because the ICE adapter's GPGNet traffic is relayed
over that same lobby connection (`relay.rs:7,23-25`). A player in a running game
loses signalling and result reporting, not just a game list. Three things follow:

1. **Connect lazily.** The phone opens no lobby session at app start. It opens
   one when the Play tab is first used, and not before. Reading news, chat or
   the leaderboard on a phone must never sign anybody out.
2. **Warn before, not after.** A one-time confirmation on that first use, naming
   the real consequence. The source string: *"Connecting here signs you out of
   the FAF client on your PC. If a game is running there, it will lose its
   connection to the server."*
3. **Never reconnect after a kick.** The desktop client retries a dropped
   session immediately (`lobby_ws.rs:369-380`), which is right for it and fatal
   here: two instances of the same code would sign each other out in a loop, for
   as long as both are open. The mobile build stops on a kick and says the PC
   client took the session back.

### What the moderation team will see

Not many IPs. **One machine, one IP, many accounts**: the silhouette of a smurf
farm, with the opposite cause.

The moderator client's own search (`UserSearchProperty.java` in
`faf-moderator-client`) goes by *Ip Address*, *UID Hash*, and the decrypted
parts: *Device Id*, *CPU Name*, *UUID*, *Serial Number*, *Processor Id*, *Bios
Version*, *Volume Serial Number*, *Memory Serial Number*, *Manufacturer*. The
proof is not opaque to them; the policy service keeps it as a searchable
hardware inventory. So a search on our hash returns every mobile player, and any
one mobile player's `uniqueIdAssignments` shows our server's hash beside their
own PC's.

Three things distinguish this from the thing it resembles, and they are worth
knowing in the order of how convincing they are:

1. **The shape of the assignments.** A real smurf farm is accounts whose *only*
   machine is the shared one. Mobile users each also carry their own PC. "This
   person has their computer and additionally a server" reads differently at a
   glance from "these twenty accounts exist on one box". The exception is a
   player who only ever uses the phone, who really does carry nothing but our
   hash.
2. **The user agent.** Stored on the login row and exported as the Prometheus
   gauge `server_user_connections{user_agent, version}`. The desktop sends
   `faf-rust-client` (`lobby_ws.rs:52`); the mobile build must send something
   unmistakable, `faf-rust-client-mobile`. One constant, and the row that looks
   suspicious carries its own explanation.
3. **The hardware profile.** A datacenter host should not look like a gaming PC
   in *Manufacturer* and *Bios Version*. This is an expectation, not a
   measurement; see the check in `faf-uid-service.md`.

The cost that matters is not to our users, it is to the moderators' tooling:
"show me every account on this machine" is the standard move against ban
evasion, and our hash would answer it with hundreds of unrelated players. That
is the argument for asking that this one hash be exempted from association, put
that way round, because it is true that way round.

And there is a second cost, which an exemption cannot fix because it is not the
policy service's table. `login` holds **one row per account**, with a single
`ip` and a single `user_agent` column (`db/models.py:176-188`), and a login is an
UPDATE, not an INSERT (`lobbyconnection.py:760-770`). The lobby server keeps no
IP history. So a mobile login **overwrites the player's recorded IP with the
backend's**, and their real address is gone from the field the moderator client
searches as *Ip Address* until they next sign in from their PC.

Nothing on our side can prevent that; the server records the address it sees.
What resolves it is that `ip` and `user_agent` are written in the same
statement: wherever that row says `faf-rust-client-mobile`, the address beside
it is ours and not the player's. The two fields travel together, so the record
explains itself, provided the moderation team has been told. Which is the third
item of the disclosure, and the one they are least likely to expect.

### What is new in the code

The desktop produces the proof by spawning a binary (`generate_unique_id` in
`lobby_ws.rs`). The mobile build gets the proof over HTTP instead, so the
production of `unique_id` becomes a seam rather than a `Command`. Everything
around it (the handshake, the session id marshalling, the validation that
refuses to send a non-proof as a credential) stays as it is.

### IRC nicks, separately

Chat authenticates over SASL as the account and then takes the account name as
its nick, which the desktop client is already holding. Ergo supports several
clients on one account, so this is probably a matter of connecting as a second
session rather than as a second user, but it needs to be proven against the real
server before the chat tab is promised. Until then, chat is read-only on the
phone, which is also the safer first version.

---

## 6. Feature by feature

| Tab | Where the work happens | Notes |
|---|---|---|
| News | iframe, no backend | `www.faforever.com/newshub` embeds; the carousel's scrolling is upstream. |
| Units | iframe, no backend | `faforever.github.io/etfreeman-db`. |
| Changelog | existing `changelog` service | Public documents; the one tab that could work before login. |
| Leaderboard | existing `leaderboard` service | Leagues and leaderboards stay two resources. |
| Maps / Mods | existing `maps` / `mods` services | Browse, search, detail, reviews. No install: there is nothing to install into. |
| Tournaments | existing `tourney` service | Read, plus signup if the phone is the natural place for it. |
| Events | existing `events` service | Still gated on the Discord token being present. |
| Training | existing `training` and `guides` services | Read-only on a phone; the write paths compose a forum post anyway. |
| Chat | existing `chat` service, IRC connection on the server | Read-only first; see section 5. |
| Play | existing `lobby` service, new proof adapter | Read-only: which games are open, who is in them, on which map. No join, no host, no matchmaker. Signs the PC client out; see section 5. |

Absent, and not by oversight: replays, game launch, ICE, the map generator,
vault installs, the client updater, uploads.

### Notifications, in the app only

**Decided: no push.** Notifications appear in the running app, the way they do
on the desktop, and nowhere else. No service worker waking up, no web push, no
iOS home-screen requirement, no notification permission prompt.

That is the right call for a reason beyond taste. A push notification worth
sending (a friend came online, someone invited you to a party) would need a
lobby session for that player held open permanently on our server, which means
their PC client stays signed out permanently rather than for as long as they
have the Play tab open. The one-off kick of section 5 is a decision; a permanent
one is a different product. Going native would not change this: it is the lobby
protocol, not the platform.

The work is small, because the notification centre is already backend-owned
state. `faf-domain/src/state/notifications.rs` holds `NotificationState`, its
items and its add/read/dismiss/clear events, so the phone gets the same feed
through the same mirror and only has to render it. The port set decides the rest
for us: `MapGenerated`, `GameCacheAlert`, `GameInstall`, `ReplayAvailable`,
`GameLaunched` and `ClientUpdate` can never fire on a build whose paths,
process, replay, map_generator and updater ports are stubs. What remains is what
a phone is actually for: `PrivateMessage`, `Mention`, `FriendOnline`,
`FriendPlaying`, `NewCustomGame`, `PartyInvite`, `EventReminder` and the two
server notices.

---

## 7. Phases

**Phase 0, unblocking, and it is the owner's to do.** Decide the host and
domain. Ask FAF to register the web OAuth client against that redirect URI. Get
the `faf-uid` service stood up to the contract in `faf-uid-service.md`. Tell FAF
that many accounts will present one uid hash from one host, and ask whether that
hash can be exempted from association. Nothing below can be tested against
production until the OAuth registration lands.

**Phase 1, the skeleton.** The new repository with its submodule and preinstall
check, the feature gates here, the server crate, the transport, the session
registry, the web auth adapter, the phone shell with its bottom tab bar, and
exactly one tab end to end: Changelog, because it is public. Deployed, on a
phone, before anything else is added.

**Phase 2, the read-only tabs.** Leaderboard, maps, mods, tournaments, events,
training, plus the two embeds. This is mostly UI work: the services already
exist and already work.

**Phase 3, the play tab.** The HTTP proof adapter, the per-player lobby session,
the lazy connect with its confirmation, the no-reconnect-after-kick rule, the
game list and the game detail with its lineup. Read-only throughout.

**Phase 4, chat.** Read first, then writing once the nick question has an
answer.

**Phase 5, the PWA finish.** Install manifest, icons, an app-shell service
worker, safe-area insets, and a measured budget on a mid-range phone over mobile
data.

---

## 8. Risks worth naming now

- **The snapshot is large.** The desktop mirror recovers by refetching the whole
  `AppState`, which is fine over an IPC channel and expensive over mobile data.
  The mobile port set is smaller, but the first thing Phase 1 should measure is
  the byte size of a real snapshot, and the answer may force per-tab lazy state.
- **We would be holding refresh tokens.** A server of ours that keeps FAF
  refresh tokens for many players is a target, and an incident there is an
  incident for FAF. Server-side sessions with HttpOnly cookies, short-lived
  access tokens, nothing in browser storage.
- **One IP in front of the FAF API.** Every mobile user's traffic arrives at FAF
  from our host. Rate limiting and caching are ours to get right, and FAF should
  be told the traffic is coming.
- **The whole Play tab rests on `ignore_result=True`.** One keyword argument in
  `lobbyconnection.py:722` is what lets many accounts share one machine proof.
  If FAF ever enforces the policy result again, every mobile user hits the
  "already associated with another FAF account" wall on the same day. This is
  survivable (the Play tab degrades, the rest of the app does not), but it is
  the reason FAF should be told rather than left to discover it.
- **The uid service is a credential factory.** Anything that can call it can
  mint lobby-valid machine proofs from Nuggets' host. It needs authentication
  and it must not be reachable from the open internet.
- **A second shell to maintain.** The two UIs share the store and the design
  system, but they do not share layout. Every new feature becomes a question of
  whether it also appears on the phone.
- **The pin goes stale.** A submodule nobody advances is a fork with extra
  steps. The mobile repo should update it on a rhythm, not in a crisis.
- **A web server's dependency list.** axum, tower, a cookie layer, a session
  store: every one of them is new, and every one of them gets the CLAUDE.md
  section 2 treatment in the pull request that introduces it.
- **Hosting is a running cost and a running duty.** Unlike the desktop client,
  this thing can be down.

---

## 9. Still open

1. Host and domain, and who operates it. Blocks the OAuth ask.
2. The repository's name and where it lives: the `FAForeverRustClient`
   organisation alongside this one, or elsewhere.
3. Whether FAF is content that many accounts will present one uid hash, and
   whether that hash can be exempted from association in the policy service.
4. Whether the `faf-uid` service lives on the same host as the backend or is
   called across the network. It may be either: the lobby server never
   correlates the proof with the connecting IP, and the policy payload
   (`lobbyconnection.py:583-588`) carries no address at all.
5. Whether chat ships read-only first. The recommendation is yes.
