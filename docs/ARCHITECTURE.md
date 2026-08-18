# FAF Rust Client: Architecture

> **Status:** Active implementation. The core loop and primary client features are operational.
> **Stack:** Rust backend + Tauri shell, React frontend reusing the ForgeMapToolkit design system.
> **Prime directive:** one source of truth, fully state-driven UI, no per-tab logic drift, no refactoring storms.

This document is the contract for how the client is built. If a change violates a rule here, change the rule on purpose (with a PR to this file): don't quietly break it.

---

## 1. Core principle: one unidirectional loop across the Tauri boundary

The entire client is a single, unidirectional data-flow loop. State lives in Rust. The frontend holds a **reactive projection** of it. There is exactly one way state changes.

```
        ┌────────────────────── Rust backend (authoritative) ───────────────────────┐
        │                                                                            │
  UI ──Command──▶ Dispatcher ──▶ Service (effects via Ports) ──yields──▶ Event(s) ─┐ │
  ▲                                                                                │ │
  │                                 ┌──────── pure reduce(state, event) ◀──────────┘ │
  │                                 ▼                                                 │
  │                           AppState  (THE single source of truth)                 │
  │                                 │                                                 │
  └──────── store mirror ◀──emit─── │ (the SAME Event, serialized to the frontend)    │
            (Zustand)                                                                 │
        └────────────────────────────────────────────────────────────────────────────┘
```

### Non-negotiable rules

1. **State changes only inside a pure reducer**, by applying an `Event`. Nothing else mutates `AppState`.
2. **Services never mutate state.** They perform side effects (IO) and *emit events*.
3. **The same `Event` that updates Rust state is serialized to the frontend.** The frontend reducer is a mirror. The UI cannot disagree with the backend: they consume the identical delta stream.
4. **The UI holds no business logic.** A tab = *select a slice of state* + *dispatch a command*. Nothing more.
5. **Command results return as events, not as `invoke` return values.** Direct `invoke` returns are reserved for pure, stateless queries (e.g. "is this path valid?").

This is Redux/Elm, but the store lives in Rust and the frontend store is its projection.

---

## 2. Crate structure (4-crate workspace)

We start lean. Internal module boundaries are real and enforced by review; crates are split out later only when a module earns its own compile boundary.

```
rust-client/
├─ Cargo.toml                 # workspace
├─ crates/
│  ├─ faf-domain/             # PURE. Zero IO, no tokio.
│  │   ├─ state/              #   one file per slice: session, chat, lobby, vault, social, settings
│  │   ├─ events.rs           #   AppEvent = enum of per-domain event enums
│  │   ├─ commands.rs         #   AppCommand = enum of per-domain command enums
│  │   ├─ reducer.rs          #   reduce(&mut AppState, &AppEvent): pure, total, tested
│  │   └─ protocol/           #   wire DTOs + encode/decode (lobby, irc, api, ice, replay). Pure.
│  │
│  ├─ faf-app/                # ALL async + IO lives here.
│  │   ├─ ports/              #   external-boundary traits; `ports/mod.rs` is canonical
│  │   ├─ infra/              #   concrete Port impls (the ONLY place with real IO)
│  │   ├─ services/           #   business logic, one module per feature:
│  │   │                      #     auth/ chat/ lobby/ vault/ launcher/ replay/ social/
│  │   └─ runtime/            #   Dispatcher, event bus (broadcast), the reduce loop, lifecycle
│  │
│  ├─ faf-ipc/                # tauri-specta contracts: typed commands/events + TS export
│  │
│  └─ src-tauri/              # thin Tauri binary: builds faf-app, registers commands,
│                             #   forwards every AppEvent -> emit(). ~no logic.
│
└─ ui/                        # React frontend (ForgeMapToolkit design system)
   ├─ design-system/          #   reused primitives + CSS tokens (tokens.css, primitives.css)
   ├─ ipc/                    #   generated typed client + single event-subscription hook
   ├─ store/                  #   Zustand slices + one event reducer (mirror of faf-domain)
   └─ features/<tab>/         #   container (selectors + dispatch) + view (primitives only)
```

### Dependency direction (enforced by the crate graph)

```
faf-domain   ← depends on NOTHING
faf-app      ← depends on faf-domain        (ports → domain, services → ports+domain, infra → ports)
faf-ipc      ← depends on faf-domain
src-tauri    ← depends on faf-app + faf-ipc
ui/          ← depends on generated faf-ipc TS bindings only
```

A service can **never** reach a socket or the filesystem directly: only through a `Port` trait. `infra` is the only module allowed to do real IO. This is what makes everything testable and stops coupling rot.

### Why these 4 crates

- **`faf-domain`** is pure and dependency-free, so the reducer and protocol codecs: the bulk of the logic: are trivially unit-testable with zero setup.
- **`faf-app`** quarantines all async/IO. `ports`/`infra`/`services`/`runtime` are separate *modules* now; any can be promoted to its own crate later without moving logic.
- **`faf-ipc`** isolates the type-generation boundary so backend and frontend types can never drift (see §5.7).
- **`src-tauri`** stays thin: it's glue, not logic.

---

## 3. Shared state design (the core)

### 3.1 One state struct, composed of slices

```rust
// faf-domain/state/mod.rs
#[derive(Clone, Default, Serialize, specta::Type)]
pub struct AppState {
    pub session:  SessionState,
    pub auth:     AuthState,
    pub chat:     ChatState,
    pub lobby:    LobbyState,
    // …one field per module in `faf-domain/src/state/`
}
```

Each slice lives in its own file with its own reducer and tests. `AppState` is pure aggregation: it has no methods beyond dispatching `reduce` to slice reducers. **No god struct.**

### 3.2 Events: the only mutation, shared with the frontend

```rust
// faf-domain/events.rs
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub enum AppEvent {
    Session(SessionEvent),
    Auth(AuthEvent),
    Chat(ChatEvent),
    Lobby(LobbyEvent),
    // …one variant per state slice
}
```

Namespaced **enum-of-enums**, never one flat enum: this keeps the event surface from exploding as features land.

### 3.3 The reducer: pure and total

```rust
// faf-domain/reducer.rs
pub fn reduce(state: &mut AppState, event: &AppEvent) {
    match event {
        AppEvent::Session(e) => session::reduce(&mut state.session, e),
        AppEvent::Chat(e)    => chat::reduce(&mut state.chat, e),
        AppEvent::Lobby(e)   => lobby::reduce(&mut state.lobby, e),
        // …each slice reducer is pure and sees only its slice
    }
}
```

No IO, no async, no `Result`. Tested as plain `(state, event) -> state` assertions. **This single function is the entire mutation surface of the app.**

### 3.4 Services emit events; they never touch `AppState`

```rust
// faf-app/services/lobby/mod.rs
pub async fn handle(cmd: LobbyCommand, ports: &Ports, out: &EventSink) -> anyhow::Result<()> {
    match cmd {
        LobbyCommand::Host(req) => {
            out.emit(LobbyEvent::Hosting.into());        // optimistic state
            let game = ports.lobby.host(req).await?;     // effect via Port
            out.emit(LobbyEvent::Hosted(game).into());   // result as event
        }
        // …
    }
    Ok(())
}
```

Testable with a **mock `Ports`** and an event-capturing `EventSink`: no network, no Tauri.

### 3.5 The runtime loop (faf-app/runtime)

```
commands in (mpsc) ──▶ Dispatcher routes to Service
                          Service drives Ports, emits Events (broadcast)
                              ├─▶ reduce(&mut AppState, &event)     (authoritative state)
                              └─▶ broadcast event to src-tauri ──▶ emit("app://event")
```

The reduce step and the frontend-emit step consume the **same event value**, so backend state and frontend store are guaranteed identical.

Runtime concurrency is expressed as policy, not as raw synchronization fields:

- `SingleFlight` rejects overlapping ownership of one long-running operation;
- `LatestRequest` gives replaceable reads a generation token so stale results cannot land;
- `SerialMutation` orders short writes that must not overtake one another.

These types live in `faf-app/runtime/policies.rs`. Services choose the policy that
matches the operation; they do not select atomic memory orderings or share bare
mutation mutexes. Long-lived lobby/chat connections deliberately remain
single-flight rather than serial mutations, so `Disconnect` is never queued
behind the connection task.

### 3.6 Frontend mirror

```ts
// ui/store/reducer.ts : mirrors faf-domain/reducer.rs
function applyEvent(state, event: AppEvent) {
  switch (event.kind) {
    case "Session": sessionReducer(state.session, event); break;
    case "Lobby":   lobbyReducer(state.lobby, event);     break;
    // …one slice reducer per domain
  }
}

// ui/ipc/events.ts: single delta subscription for the whole app
listen<AppEvent>("app://event", e => store.getState().apply(e.payload));
```

One ordinary delta subscription and one reducer keep the slices mirrored. A separate,
normally idle snapshot channel repairs the mirror if the bounded backend broadcast
receiver ever lags; it is a recovery path, not a second source of mutations. Tabs
only select state and dispatch typed commands. `RevisionedMirror` also verifies that
ordinary event revisions are contiguous. It buffers an event that crosses a gap,
coalesces concurrent recovery requests, replaces the mirror from a fresh snapshot,
and only then drains contiguous buffered events. An out-of-order delta is never
applied to a state that may have missed an earlier mutation.

This is an explicit tradeoff, not a permanent assumption. Run
`pnpm measure:state-sync [snapshot.json]` to measure serialized snapshot size and
frontend JSON cost. The checked-in conformance fixture is useful for a repeatable
lower-bound measurement, but it is not representative of a populated chat, vault,
or replay session. Do not replace delta reduction with snapshot-per-event delivery
until a captured live snapshot has been measured at realistic event rates.

### 3.7 Type safety across the boundary: kills the #1 refactor source

Use **`tauri-specta` + `specta`** to generate the TypeScript types for `AppCommand`, `AppEvent`, and every DTO directly from the Rust definitions, checked into `ui/ipc/bindings.ts` and verified in CI. Add a field in Rust → the TS won't compile until the frontend handles it. **There is no hand-written duplicate type anywhere.** This one choice eliminates the most common Tauri refactor storm.

---

## 4. Frontend / UI integration (ForgeMapToolkit design system + Zustand)

The ForgeMapToolkit design system is the **view layer only**.

- **`design-system/`**: existing tokens + primitives lifted in as-is (`tokens.css`, `primitives.css`, primitive components). It stays a pure presentation library.
- **A feature is a folder, not a class:** `features/<tab>/` owns its view and focused
  subcomponents. Small features may colocate selection and presentation in one file;
  larger features extract dedicated components and pure helpers as they grow.
  - Feature views select backend state and dispatch typed commands.
  - Presentational subcomponents receive data and callbacks through props and compose
    design-system primitives.
  - Mature multi-view features keep their workspace shell small and give each tab,
    advanced form, and reusable card/detail family its own module.
  - Feature-specific CSS lives beside its feature; the global stylesheet is reserved
    for shell layout, shared patterns, and cross-feature responsive rules.
  - There are **no "element classes."** Composition of primitives only. This structurally prevents "too many classes for simple UI elements."
- **One IPC boundary + one ordinary event stream** for the entire app, plus the
  snapshot-only lag recovery described above. `ipc/client.ts` owns typed domain
  commands and events; `ipc/native.ts` owns narrow desktop facilities such as file
  dialogs, notifications, external URLs and window focus. Features never import
  Tauri packages directly. `pnpm run architecture` enforces both this rule and the
  Rust service/infra dependency direction in CI.
- **Store:** Zustand slices mirror the backend slices. The root reducer is only an
  event router; each domain owns its pure frontend slice reducer (§3.6).
- Routing reuses the existing ForgeMapToolkit `tabRoutes` pattern.

Net effect: restyle freely without touching logic; add a tab without touching any other tab.

---

## 5. External boundaries → Ports

Each external system is a `Port` trait in `faf-app/ports`, implemented in
`faf-app/infra`, and mockable in tests. The canonical, compile-checked list is
the [`Ports` bundle in `crates/faf-app/src/ports/mod.rs`](../crates/faf-app/src/ports/mod.rs).
Do not duplicate that list here: adding a port must update the bundle, while a
hand-maintained documentation table can silently drift.

Read-only request ports may use `ports::RequestError` when the frontend can act
on the distinction between expired authentication, temporary unavailability,
missing resources, rejected input and an unexpected client/response failure. The
co-op path is the reference vertical slice. `infra::jsonapi::fetch_document_typed`
preserves the category; the older `fetch_document` wrapper intentionally remains
for adapters whose state and UI still accept only a sentence. Do not mechanically
migrate those ports until the category produces a real recovery action.

Long-lived/complex protocols (lobby, ICE) are each modeled as an **explicit state machine** inside their service, isolated and unit-tested.

The lobby socket is a transport for several domain slices, not the owner of those
slices. `services::lobby::connect` owns the connection lifecycle and
`handle_update` demultiplexes one `LobbyUpdate` at a time into lobby, social, and
notification events. Keep new server-pushed messages in
that named update boundary rather than growing the `LobbyCommand::Connect` arm.

---

## 6. Risks & how the design prevents refactoring storms

| Risk (past pain) | Structural prevention |
|---|---|
| BE/FE type drift | `tauri-specta` generated types, CI-gated. No hand-written duplicates. |
| God state struct | `AppState` = slices, each its own file + reducer; aggregation only. |
| Event/command enum explosion | Namespaced enum-of-enums per domain; never one flat enum. |
| Services coupling to IO | `ports` traits + DI; services can't see `infra`. Enforced by module/crate graph. |
| Per-tab logic drift | Tabs = select + dispatch only; one IPC module; logic lives in services. |
| Long-lived protocol complexity | Lobby/ICE modeled as explicit, isolated, unit-tested state machines. |
| Subprocess fragility (ICE, game) | Behind `ProcessPort`; lifecycle owned by launcher service; mockable. |
| "Invoke returns data" sprawl | State changes flow only as events; direct returns limited to pure queries. |
| Untestable async glue | Pure reducer + pure codecs + mockable ports = the bulk is testable without IO. |

---

## 7. Phase plan

### Phase 1: design (this document). Done.

### Phase 2: prove the loop end-to-end with ONE piece of state. No networking, no auth.

1. **Workspace skeleton:** `faf-domain`, `faf-app`, `faf-ipc`, `src-tauri`, `ui/`. Everything compiles, empty.
2. **One slice:** `SessionState { backend_version: String, status: ConnectionStatus }`. Define `SessionEvent`, `SessionCommand`, and the pure slice `reduce`: **with unit tests**.
3. **Runtime loop:** `Dispatcher` (mpsc) + event `broadcast` + reduce step. One trivial `session` service handling a `Hello` command, emitting `BackendReady { version }`.
4. **tauri-specta:** export TS bindings; `src-tauri` forwards every `AppEvent` to `emit("app://event")`.
5. **Frontend loop:** typed IPC module + single `listen` hook + Zustand store with the `session` slice + mirror reducer. Status bar driven entirely by state.
6. **Prove it:** app start → FE dispatches `Hello` → service emits `BackendReady` → reducer updates Rust `AppState` → same event emits to FE → store updates → status bar renders. One closed, fully-typed loop, tested at the reducer level.

### Phase 3: first real feature (auth). Done.

Validated the "mechanical addition" claim by building the **auth** slice end-to-end and,
in doing so, the pieces Phase 2 stubbed:

- **Ports/infra layer** (`faf-app/ports/auth.rs`, `faf-app/infra/auth.rs`): an `AuthPort`
  trait with a `FakeAuth` impl, injected via a `Ports` bundle on `ServiceCtx`. The real
  OAuth2 provider lands later behind the same trait: service/slice/UI unchanged.
- **Concurrent dispatch**: the loop spawns each command handler so a slow effect (login)
  never blocks other commands; state mutation still funnels through the single `emit`.
- **State-driven routing**: the UI picks login vs. the active destination purely from `auth.status`: no
  router logic in components.
- **Mockability**: auth service tested (success + failure) by swapping the port, no IO.

### Phase 4: navigation + streaming lobby. Done.

Added the **nav** and **lobby** slices, exercising two things Phases 2–3 hadn't:

- **Streaming port** (`LobbyPort::connect` → `mpsc::Receiver<Vec<Game>>`): the first
  *server-push* boundary, vs. auth's request/response. The lobby service forwards each
  snapshot as a `GamesUpdated` event in a long-lived loop: which, thanks to per-command
  task spawning, never blocks other commands. This is the pattern chat/IRC/live-replay reuse.
- **Navigation in the source of truth**: `nav.activeTab` lives in `AppState`, changed via
  the same command→event loop. Deliberate: it lets backend logic drive the view (e.g.
  "joined a game → switch tab") and survives reconnects. Ephemeral widget state (hover, an
  open dropdown) still belongs in components, not here.
- **Multi-tab shell**: `AppShell` renders a `TabBar` + active-tab content as a pure switch
  on `nav.activeTab`. Adding a tab = add a `Tab` variant + a feature folder; no other tab changes.

### Phase 5+: remaining features as mechanical additions.

Each feature = *new slice + new service + new port impl*. None can introduce spaghetti: a service can't touch state, a tab can't touch logic.

- **CI + bindings-drift check. Done.** `.github/workflows/ci.yml` runs `cargo test`, `cargo clippy -D warnings`, `tsc --noEmit`, `vite build`, and a job that regenerates `ui/src/ipc/bindings.ts` and fails on any diff: the type-drift guard, enforced.
- **Real OAuth2. Done.** `faf-app/infra/oauth.rs` (`OAuthAuth`) implements `AuthPort` against FAF's Ory Hydra (Authorization Code + PKCE, loopback redirect listener, token exchange, keyring storage, `/me` lookup). `FakeAuth` stays for tests/offline (`FAF_FAKE_AUTH=1`). Service, slice and UI were untouched: the "swap the infra" claim, proven.
- **Real lobby protocol + disconnect/cancellation. Done.** `faf-app/infra/lobby_ws.rs` (`LobbyClient`) speaks the FAF lobby WebSocket protocol (`ask_session`→`auth`→`game_info`) behind `LobbyPort`, aggregating `game_info` into the open-games list. `LobbyPort` gained `disconnect()` and the slice a `Disconnect` command, retiring the Phase-4 debt; cancellation is a `CancellationToken` shared between `connect` and `disconnect`, exercised by both fakes and the real client. The shared `TokenStore` (`infra/session.rs`) carries the OAuth access token from auth to the lobby without ever entering `AppState`. Lobby auth's anti-smurf `unique_id` is produced by running FAF's official `faf-uid` executable (`FAF_UID_PATH`) with the server-issued session: we invoke the binary rather than reproducing its encryption. `LobbyClient` is selected automatically for account sessions; `FakeLobby` remains available through `FAF_FAKE_LOBBY=1` or the fully offline `FAF_FAKE_AUTH=1` mode.

- **Settings + theming (central UI system). Done.** A `settings` slice: the first *persisted* slice: holds the UI `theme` (a typed `Theme` enum, so the frontend can't pick an invalid theme). New `SettingsPort` + `FileSettings` (JSON in the OS config dir) persist it; `SettingsCommand::Load` runs at startup, `SetTheme` persists on change. The service shows the persistence pattern: it emits the event (single reduce chokepoint), then reads the *post-reduce* slice back via `EventSink::with_state` and hands it to the port: services still never mutate state, and unrelated slices are not cloned. The frontend projects `settings.theme` onto `<html data-theme>`; every component reads semantic CSS variables only, so the four shipped themes (`forgeDark`/`forgeLight`/`javaClient`/`pythonClient`) are pure token sets in `tokens.css`. A `Button` primitive centralizes control structure, and a dependency-free CI gate forbids hardcoded hex in component CSS. This is the contract that means a new design system never revisits a component file.

- **Tournaments. Done, and rebuilt once.** The first *role-gated write* surface, and the
  clearest demonstration of what the port boundary is for. It shipped against FAF's Challonge
  bridge (`ChallongeController` forwarding `/challonge/**` with FAF's own key), and was later
  repointed at `faf-tournaments`, the tournament team's own service, without the slice's
  *shape* changing: `TourneyPort` replaced `TournamentsPort`, `infra/tourney.rs` replaced the
  Challonge form encoding, and the service's read/write policies carried over untouched.

  Three conventions come out of it, and all three generalise:

  1. **A role in the client is visibility, never authorisation.** `Player::roles` is read
     from the identity token's `ext.roles` *without verifying the signature*, and can be
     overridden entirely by `FAF_FAKE_ROLES`. Both are sound because the value only decides
     whether a control is drawn: the server validates the token properly and answers 403
     regardless. Anything that treated a client-side role as permission would be trusting a
     value the client itself decoded.

     The tournament service goes one better and simply tells the client who it is: every
     `GET /api/t/{id}` carries a `viewer` block naming this account's entry, its team and
     whether it organises the event. That is taken as given rather than re-derived from the
     FAF id, because the server authorises every write against the same answer, and a second
     opinion computed here could only ever disagree with the one that counts.
  2. **A write reloads rather than patches.** Confirming a score advances the winner along
     the bracket, eliminates the loser and can finish the tournament outright, none of which
     is in the response. So the service re-reads the list and the open event after every
     mutation. Writes are serialised (`tourney_mutation`) and detail reads carry a generation
     token (`tourney_detail_generation`), because command order is not response order.
  3. **The server's refusal is the best error message available.** `faf-tournaments` answers
     400 and 403 with a sentence written for the player: which rating gate they missed, when
     check-in opens, how many replay ids are still wanted. `infra/tourney.rs` passes it
     through verbatim rather than mapping it to a category and losing it.

- **Entrants are FAF players, not strings. Done.** Challonge modelled an entrant as free
  text, which is why no FAF tournament tool has ever shown an avatar or a rating next to a
  bracket row; the client worked around it by smuggling the account id through Challonge's
  255-character `misc` field. `faf-tournaments` carries `fafId` as a first-class field, so
  the workaround is gone and the capability stayed: avatars, ratings, the player card and
  private messages all follow from the entry itself.

  Third-party markup never enters the state. Tournament descriptions, chat posts and rules
  pages are organiser-authored HTML, and they are reduced to plain text at the boundary by
  `protocol::markup` before they reach `AppState`. The Java client renders such content in a
  `WebView` it already treats as untrusted; here it would land in the client's own document.

Remaining order: chat → vault → launcher/ICE → replay → social → updater.

---

## 8. Conventions (quick reference)

- New state? → add a **slice** + its reducer + tests in `faf-domain/state/`.
- New backend capability? → add a **command + event(s)** + a **service** in `faf-app/services/`.
- New external system? → add a **`Port` trait** + an **`infra` impl** + a **mock** for tests.
- New screen? → add a **`features/<tab>/`** folder; container selects + dispatches, view uses primitives.
- Never: mutate state outside a reducer; do IO outside `infra`; put logic in a component; hand-write a cross-boundary type.
