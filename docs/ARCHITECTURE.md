# FAF Rust Client — Architecture

> **Status:** Phase 1 (design). No feature implementation yet.
> **Stack:** Rust backend + Tauri shell, React frontend reusing the ForgeMapToolkit design system.
> **Prime directive:** one source of truth, fully state-driven UI, no per-tab logic drift, no refactoring storms.

This document is the contract for how the client is built. If a change violates a rule here, change the rule on purpose (with a PR to this file) — don't quietly break it.

---

## 1. Core principle — one unidirectional loop across the Tauri boundary

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
3. **The same `Event` that updates Rust state is serialized to the frontend.** The frontend reducer is a mirror. The UI cannot disagree with the backend — they consume the identical delta stream.
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
│  │   ├─ reducer.rs          #   reduce(&mut AppState, &AppEvent) — pure, total, tested
│  │   └─ protocol/           #   wire DTOs + encode/decode (lobby, irc, api, ice, replay). Pure.
│  │
│  ├─ faf-app/                # ALL async + IO lives here.
│  │   ├─ ports/              #   trait defs: LobbyPort, IrcPort, ApiPort, IcePort,
│  │   │                      #     ProcessPort, FsPort, AuthPort, ClockPort
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

A service can **never** reach a socket or the filesystem directly — only through a `Port` trait. `infra` is the only module allowed to do real IO. This is what makes everything testable and stops coupling rot.

### Why these 4 crates

- **`faf-domain`** is pure and dependency-free, so the reducer and protocol codecs — the bulk of the logic — are trivially unit-testable with zero setup.
- **`faf-app`** quarantines all async/IO. `ports`/`infra`/`services`/`runtime` are separate *modules* now; any can be promoted to its own crate later without moving logic.
- **`faf-ipc`** isolates the type-generation boundary so backend and frontend types can never drift (see §5.7).
- **`src-tauri`** stays thin — it's glue, not logic.

---

## 3. Shared state design (the core)

### 3.1 One state struct, composed of slices

```rust
// faf-domain/state/mod.rs
#[derive(Clone, Default, Serialize, specta::Type)]
pub struct AppState {
    pub session:  SessionState,   // connection + auth status
    pub chat:     ChatState,
    pub lobby:    LobbyState,
    pub vault:    VaultState,
    pub social:   SocialState,
    pub settings: SettingsState,
}
```

Each slice lives in its own file with its own reducer and tests. `AppState` is pure aggregation — it has no methods beyond dispatching `reduce` to slice reducers. **No god struct.**

### 3.2 Events — the only mutation, shared with the frontend

```rust
// faf-domain/events.rs
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub enum AppEvent {
    Session(SessionEvent),
    Chat(ChatEvent),
    Lobby(LobbyEvent),
    Vault(VaultEvent),
    Social(SocialEvent),
}
```

Namespaced **enum-of-enums**, never one flat enum — this keeps the event surface from exploding as features land.

### 3.3 The reducer — pure and total

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

Testable with a **mock `Ports`** and an event-capturing `EventSink` — no network, no Tauri.

### 3.5 The runtime loop (faf-app/runtime)

```
commands in (mpsc) ──▶ Dispatcher routes to Service
                          Service drives Ports, emits Events (broadcast)
                              ├─▶ reduce(&mut AppState, &event)     (authoritative state)
                              └─▶ broadcast event to src-tauri ──▶ emit("app://event")
```

The reduce step and the frontend-emit step consume the **same event value**, so backend state and frontend store are guaranteed identical.

### 3.6 Frontend mirror

```ts
// ui/store/reducer.ts  — mirrors faf-domain/reducer.rs
function applyEvent(state, event: AppEvent) {
  switch (event.kind) {
    case "Session": sessionReducer(state.session, event); break;
    case "Lobby":   lobbyReducer(state.lobby, event);     break;
    // …one slice reducer per domain
  }
}

// ui/ipc/events.ts — single subscription for the whole app
listen<AppEvent>("app://event", e => store.getState().apply(e.payload));
```

One subscription, one reducer, slices mirror the backend. Tabs only `useStore(s => s.lobby.games)` and `dispatch(LobbyCommand.Host(...))`.

### 3.7 Type safety across the boundary — kills the #1 refactor source

Use **`tauri-specta` + `specta`** to generate the TypeScript types for `AppCommand`, `AppEvent`, and every DTO directly from the Rust definitions, checked into `ui/ipc/bindings.ts` and verified in CI. Add a field in Rust → the TS won't compile until the frontend handles it. **There is no hand-written duplicate type anywhere.** This one choice eliminates the most common Tauri refactor storm.

---

## 4. Frontend / UI integration (ForgeMapToolkit design system + Zustand)

The ForgeMapToolkit design system is the **view layer only**.

- **`design-system/`** — existing tokens + primitives lifted in as-is (`tokens.css`, `primitives.css`, primitive components). It stays a pure presentation library.
- **A feature is a folder, not a class:** `features/<tab>/{ container.tsx, view.tsx, selectors.ts }`.
  - `container.tsx` — selects state + dispatches commands. No other logic.
  - `view.tsx` — pure, composed from design-system primitives only.
  - There are **no "element classes."** Composition of primitives only. This structurally prevents "too many classes for simple UI elements."
- **One typed IPC module + one event hook** for the entire app. Tabs never call `invoke`/`listen` directly. This is what kills per-tab inconsistency — every tab talks to the backend the same way.
- **Store:** Zustand, slices mirroring the backend slices, one event reducer (§3.6).
- Routing reuses the existing ForgeMapToolkit `tabRoutes` pattern.

Net effect: restyle freely without touching logic; add a tab without touching any other tab.

---

## 5. External boundaries → Ports

Each external system is a `Port` trait in `faf-app/ports`, implemented in `faf-app/infra`, and mockable in tests.

| Capability | External system | Port | Notes |
|---|---|---|---|
| Auth | OAuth2 (Ory Hydra) | `AuthPort` | Browser flow + local redirect listener, token refresh, secure storage |
| Lobby protocol | `lobby.faforever.com` | `LobbyPort` | Long-lived TCP/WS JSON stream — modeled as an explicit **state machine** |
| Chat | IRC | `IrcPort` | Channels, PMs, presence; second long-lived connection |
| API / vault | REST (JSON:API) | `ApiPort` | Maps, mods, leaderboards, players, replay metadata |
| Game connectivity | ICE adapter | `IcePort` | **Separate subprocess**, JSON-RPC over TCP |
| Game launch | `ForgedAlliance.exe` | `ProcessPort` | Subprocess + args; files staged first |
| Downloads / cache | Filesystem | `FsPort` | Maps, mods, featured-mod patches, avatars |
| Replays | local files + live relay | (`FsPort` + `LobbyPort`) | SCFA replay parsing; live replay = relay stream |
| Time | — | `ClockPort` | Injected for deterministic tests |

Long-lived/complex protocols (lobby, ICE) are each modeled as an **explicit state machine** inside their service, isolated and unit-tested.

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

### Phase 1 — design (this document). Done.

### Phase 2 — prove the loop end-to-end with ONE piece of state. No networking, no auth.

1. **Workspace skeleton:** `faf-domain`, `faf-app`, `faf-ipc`, `src-tauri`, `ui/`. Everything compiles, empty.
2. **One slice:** `SessionState { backend_version: String, status: ConnectionStatus }`. Define `SessionEvent`, `SessionCommand`, and the pure slice `reduce` — **with unit tests**.
3. **Runtime loop:** `Dispatcher` (mpsc) + event `broadcast` + reduce step. One trivial `session` service handling a `Hello` command, emitting `BackendReady { version }`.
4. **tauri-specta:** export TS bindings; `src-tauri` forwards every `AppEvent` to `emit("app://event")`.
5. **Frontend loop:** typed IPC module + single `listen` hook + Zustand store with the `session` slice + mirror reducer. Status bar driven entirely by state.
6. **Prove it:** app start → FE dispatches `Hello` → service emits `BackendReady` → reducer updates Rust `AppState` → same event emits to FE → store updates → status bar renders. One closed, fully-typed loop, tested at the reducer level.

### Phase 3 — first real feature (auth). Done.

Validated the "mechanical addition" claim by building the **auth** slice end-to-end and,
in doing so, the pieces Phase 2 stubbed:

- **Ports/infra layer** (`faf-app/ports/auth.rs`, `faf-app/infra/auth.rs`): an `AuthPort`
  trait with a `FakeAuth` impl, injected via a `Ports` bundle on `ServiceCtx`. The real
  OAuth2 provider lands later behind the same trait — service/slice/UI unchanged.
- **Concurrent dispatch**: the loop spawns each command handler so a slow effect (login)
  never blocks other commands; state mutation still funnels through the single `emit`.
- **State-driven routing**: the UI picks login vs. home purely from `auth.status` — no
  router logic in components.
- **Mockability**: auth service tested (success + failure) by swapping the port, no IO.

### Phase 4 — navigation + streaming lobby. Done.

Added the **nav** and **lobby** slices, exercising two things Phases 2–3 hadn't:

- **Streaming port** (`LobbyPort::connect` → `mpsc::Receiver<Vec<Game>>`): the first
  *server-push* boundary, vs. auth's request/response. The lobby service forwards each
  snapshot as a `GamesUpdated` event in a long-lived loop — which, thanks to per-command
  task spawning, never blocks other commands. This is the pattern chat/IRC/live-replay reuse.
- **Navigation in the source of truth**: `nav.activeTab` lives in `AppState`, changed via
  the same command→event loop. Deliberate — it lets backend logic drive the view (e.g.
  "joined a game → switch tab") and survives reconnects. Ephemeral widget state (hover, an
  open dropdown) still belongs in components, not here.
- **Multi-tab shell**: `AppShell` renders a `TabBar` + active-tab content as a pure switch
  on `nav.activeTab`. Adding a tab = add a `Tab` variant + a feature folder; no other tab changes.

### Phase 5+ — remaining features as mechanical additions.

Each feature = *new slice + new service + new port impl*. None can introduce spaghetti: a service can't touch state, a tab can't touch logic.

- **CI + bindings-drift check. Done.** `.github/workflows/ci.yml` runs `cargo test`, `cargo clippy -D warnings`, `tsc --noEmit`, `vite build`, and a job that regenerates `ui/src/ipc/bindings.ts` and fails on any diff — the type-drift guard, enforced.
- **Real OAuth2. Done.** `faf-app/infra/oauth.rs` (`OAuthAuth`) implements `AuthPort` against FAF's Ory Hydra (Authorization Code + PKCE, loopback redirect listener, token exchange, keyring storage, `/me` lookup). `FakeAuth` stays for tests/offline (`FAF_FAKE_AUTH=1`). Service, slice and UI were untouched — the "swap the infra" claim, proven.
- **Real lobby protocol + disconnect/cancellation. Done.** `faf-app/infra/lobby_ws.rs` (`LobbyClient`) speaks the FAF lobby WebSocket protocol (`ask_session`→`auth`→`game_info`) behind `LobbyPort`, aggregating `game_info` into the open-games list. `LobbyPort` gained `disconnect()` and the slice a `Disconnect` command, retiring the Phase-4 debt; cancellation is a `CancellationToken` shared between `connect` and `disconnect`, exercised by both fakes and the real client. The shared `TokenStore` (`infra/session.rs`) carries the OAuth access token from auth to the lobby without ever entering `AppState`. Lobby auth's anti-smurf `unique_id` is produced by running FAF's official `faf-uid` executable (`FAF_UID_PATH`) with the server-issued session — we invoke the binary rather than reproducing its encryption. `LobbyClient` is opt-in (`FAF_REAL_LOBBY=1`); `FakeLobby` remains the default so the app runs without that binary.

Remaining order: chat → vault → launcher/ICE → replay → social → settings/updater.

---

## 8. Conventions (quick reference)

- New state? → add a **slice** + its reducer + tests in `faf-domain/state/`.
- New backend capability? → add a **command + event(s)** + a **service** in `faf-app/services/`.
- New external system? → add a **`Port` trait** + an **`infra` impl** + a **mock** for tests.
- New screen? → add a **`features/<tab>/`** folder; container selects + dispatches, view uses primitives.
- Never: mutate state outside a reducer; do IO outside `infra`; put logic in a component; hand-write a cross-boundary type.
