# Project Guide — What's Where, and Why

> Onboarding map for new developers. **What** lives in the repo and **what** it's there for.
> The **why** behind the architecture (rationale, rules, trade-offs) is in
> [`ARCHITECTURE.md`](ARCHITECTURE.md). This document is the map; that one is the contract.

---

## 1. What is this?

A FAF client (Supreme Commander: Forged Alliance Forever) built with **Rust + Tauri** and a
**React** frontend. Backend logic lives in Rust; the UI is a reactive projection of it.

**Tech Stack:**

| Area | Technology |
|---|---|
| Backend / Domain Logic | Rust (Cargo workspace, 4 crates) |
| Desktop Shell | Tauri 2 |
| Async Runtime | tokio |
| Frontend | React 18 + Vite + TypeScript |
| State (Frontend) | Zustand |
| Rust→TS Type Bridge | specta + specta-typescript (generates `bindings.ts`) |

---

## 2. The Big Idea in 30 Seconds

Everything is **a directed loop**. There is exactly one way state can change:

```
UI dispatch ─▶ Tauri command ─▶ service ─▶ event ─▶ reduce(AppState) ─▶ emit ─▶ store ─▶ UI
```

- **State lives in Rust** (`AppState`) — the single source of truth.
- **State only changes in the reducer**, triggered by an `Event`.
- **Services** do IO (via ports) and **emit events** — they never touch state directly.
- The same `Event` that mutates Rust state is forwarded to the frontend → the frontend store is a **mirror**.
- **UI components contain no logic**: they read a state slice and dispatch commands.

Internalize this and you understand 90% of the code.

---

## 3. Crate Overview (Dependency Direction)

```
faf-domain   ← depends on NOTHING         (pure types + reducer, no IO, no async)
faf-app      ← depends on faf-domain      (runtime loop, services, ports, infra)
faf-ipc      ← depends on faf-domain      (generates the TS types)
src-tauri    ← depends on faf-app + faf-ipc (thin Tauri glue)
ui/          ← depends only on the generated TS types
```

**Golden rule:** A service never reaches a socket/filesystem directly — only through a
`Port` trait. Real IO happens **exclusively** in `faf-app/src/infra/`.

---

## 4. Repo Map (File by File)

### Root

| Path | Meaning |
|---|---|
| `Cargo.toml` | Workspace definition: member crates + shared dependency versions. |
| `package.json` | Frontend deps + npm scripts (`dev`, `build`, `tauri`, `bindings`, `typecheck`). |
| `vite.config.ts` | Vite config; `root: "ui"`, build output to `ui/dist`. |
| `tsconfig.json` | TypeScript config for the frontend (strict). |
| `README.md` | Quick start + status + commands. |
| `docs/ARCHITECTURE.md` | The **architecture contract** (rules, rationale, phase plan). |
| `docs/PROJECT_GUIDE.md` | **This document** (the map). |
| `app-icon.png` | Source icon from which Tauri icons are generated. |
| `.gitignore` | Ignores `target/`, `node_modules/`, `ui/dist/`, `src-tauri/gen/`. |

### `crates/faf-domain/` — the pure domain (no IO, no async)

The heart. Types, state, and the reducer live here. Trivially testable.

| Path | Meaning |
|---|---|
| `src/lib.rs` | Re-exports (`AppState`, `AppCommand`, `AppEvent`, `reduce`). |
| `src/state/mod.rs` | **`AppState`** — aggregates all slices. One field per slice, nothing else. |
| `src/state/session.rs` | Slice **session**: connection status. |
| `src/state/auth.rs` | Slice **auth**: login status + `Player`. |
| `src/state/nav.rs` | Slice **nav**: active tab (`Tab` enum). |
| `src/state/lobby.rs` | Slice **lobby**: list of open games (`Game`). |
| `src/events.rs` | **`AppEvent`** — enum-of-enums, one variant per slice. The only mutation source. |
| `src/commands.rs` | **`AppCommand`** — enum-of-enums, intentions from the UI. |
| `src/reducer.rs` | **`reduce()`** — the entire mutation surface of the app. Pure, total, tested. |

> **Slice structure:** Each `state/<name>.rs` contains exactly four things: its `State`, its
> `Event`s, its `Command`s, and its pure `reduce()` function. Plus unit tests.

### `crates/faf-app/` — orchestration (all async + IO lives here)

| Path | Meaning |
|---|---|
| `src/lib.rs` | Re-exports (`App`, `AppLoop`, `EventSink`, `ServiceCtx`, `Ports`). |
| `src/runtime/mod.rs` | **The loop.** `App` (handle), `AppLoop` (processes commands), `EventSink` (the *one* point where reduction + broadcasting happens), `ServiceCtx` (injected dependencies). |
| `src/ports/mod.rs` | **`Ports`** bundle (one field per external system), injected into `ServiceCtx`. |
| `src/ports/auth.rs` | Trait **`AuthPort`** — request/response (login/logout). |
| `src/ports/lobby.rs` | Trait **`LobbyPort`** — *streaming* (`connect()` → receiver of game snapshots; `disconnect()` cancels). |
| `src/ports/settings.rs` | Trait **`SettingsPort`** — `load()` / `save()` persisted preferences (best-effort). |
| `src/infra/mod.rs` | **`real_ports()` / `fake_ports()` / `ports_from_env()`** — builds the `Ports` bundle. Only IO-permitted zone. The shell uses `ports_from_env()` (real auth by default, `FAF_FAKE_AUTH=1` for offline; `FAF_REAL_LOBBY=1` for the real lobby). |
| `src/infra/oauth.rs` | **`OAuthAuth`** — real login: FAF Ory Hydra, Authorization Code + PKCE, loopback redirect listener, token exchange, `/me` lookup, keyring storage. |
| `src/infra/auth.rs` | **`FakeAuth`** — simulates login (offline); used by tests and `FAF_FAKE_AUTH=1`. |
| `src/infra/session.rs` | **`TokenStore`** — in-memory access-token holder shared from auth to network ports (never in `AppState`). |
| `src/infra/lobby_ws.rs` | **`LobbyClient`** — real FAF lobby WebSocket protocol (`ask_session`→`auth`→`game_info`), game-list aggregation, graceful disconnect. Opt-in (`FAF_REAL_LOBBY=1`); runs the `faf-uid` binary (`FAF_UID_PATH`) for the anti-smurf `unique_id`. |
| `src/infra/lobby.rs` | **`FakeLobby`** — sends a changing game list every 2s; cancellable like the real client. |
| `src/infra/settings_file.rs` | **`FileSettings`** — persists settings as JSON in the OS config dir. |
| `src/infra/settings_fake.rs` | **`FakeSettings`** — in-memory settings for tests/offline. |
| `src/services/mod.rs` | Collection module for services. |
| `src/services/session.rs` | Service **session**: handshake → reports backend version. |
| `src/services/auth.rs` | Service **auth**: command → `AuthPort` → events. |
| `src/services/nav.rs` | Service **nav**: pure UI state transition (command → event). |
| `src/services/lobby.rs` | Service **lobby**: subscribes to the stream, forwards each snapshot as an event. |
| `src/services/settings.rs` | Service **settings**: `Load` → emit `Loaded`; `SetTheme` → emit + persist post-reduce slice. |
| `tests/loop.rs` | End-to-end test of the loop (session). |
| `tests/auth.rs` | Auth service with a swapped port (success + failure). |
| `tests/lobby.rs` | Lobby streaming end-to-end, plus connect→disconnect teardown. |

> **Service structure:** A single `handle(cmd, ctx, out)` function. Reads ports via `ctx.ports`,
> calls `out.emit(event)`. **Never touches `AppState`.**

### `crates/faf-ipc/` — the type bridge (anti-drift boundary)

| Path | Meaning |
|---|---|
| `src/lib.rs` | `typescript_bindings()` — renders TS for `AppState`/`AppCommand`/`AppEvent` + all referenced types from the Rust code. |
| `src/bin/export_bindings.rs` | Binary that writes the result to `ui/src/ipc/bindings.ts`. Run with: `npm run bindings`. |

> **Important:** Run `npm run bindings` after every change to domain types.
> Otherwise the frontend won't compile — that's by design to prevent type drift.

### `src-tauri/` — the Tauri shell (thin glue, no logic)

| Path | Meaning |
|---|---|
| `src/main.rs` | Entry point; calls `forge_client_lib::run()`. |
| `src/lib.rs` | Registers Tauri commands `dispatch` + `snapshot`, forwards every `AppEvent` to the frontend (`emit("app://event")`). Injects `ports_from_env()` here. |
| `build.rs` | Tauri build hook. |
| `tauri.conf.json` | Window, build, and bundle configuration (frontend path, dev URL, icons). |
| `capabilities/default.json` | Tauri permissions for the main window (events, window). |

### `ui/` — the React frontend

| Path | Meaning |
|---|---|
| `index.html` | HTML entry point, loads `src/main.tsx`. |
| `src/main.tsx` | Mounts `<App>`. |
| `src/App.tsx` | **App root.** Single event subscription + startup handshake. Routes purely from state: logged in → `AppShell`, otherwise → `LoginView`. |
| `src/ipc/client.ts` | **The only typed bridge** to the backend (`dispatch`, `snapshot`, `onEvent`). No component calls `invoke`/`listen` directly. |
| `src/ipc/bindings.ts` | **GENERATED** from Rust. Do not edit manually. |
| `src/store/store.ts` | Zustand store; mirrors `AppState`. Write access only via `apply` (events) + `hydrate` (snapshot). |
| `src/store/reducer.ts` | **Mirror reducer** — structurally identical to `faf-domain/src/reducer.rs`. If you change the Rust reducer, change this twin too. |
| `src/design-system/tokens.css` | **Theming contract.** Semantic CSS variables under `:root` (= `forgeDark`) + one `[data-theme="…"]` block per theme (`forgeLight`/`javaClient`/`pythonClient`). Components reference these only. |
| `src/design-system/Button.tsx` | **`Button` primitive** — encapsulates control structure/classes so theme-specific shape changes touch one file. |
| `src/styles.css` | Global styles + component classes (token-driven; no hardcoded hex — enforced in CI). |
| `src/features/status/StatusBar.tsx` | View: connection status. |
| `src/features/auth/LoginView.tsx` | View: login screen. |
| `src/features/shell/AppShell.tsx` | The logged-in shell: topbar + `TabBar` + `ThemeSwitcher` + active tab content. |
| `src/features/nav/TabBar.tsx` | View: tab bar (dispatches nav commands). |
| `src/features/home/HomeScreen.tsx` | View: home tab content. |
| `src/features/lobby/LobbyView.tsx` | View: play tab — live game list. |
| `src/features/settings/ThemeSwitcher.tsx` | View: theme dropdown (dispatches `SetTheme`). |

> **Feature structure:** A folder `features/<name>/`. Components **select state +
> dispatch commands**, nothing else. No business logic, no direct IPC calls.

---

## 5. One Click, Traced Through (Login)

How data flows concretely — useful for debugging:

1. User clicks "Log in" → `LoginView` calls `ipc.dispatch({ kind: "Auth", command: { type: "login" }})`.
2. `src-tauri/src/lib.rs` (command `dispatch`) pushes the `AppCommand` into the loop.
3. `runtime/mod.rs` routes to `services/auth.rs::handle`.
4. The service emits `LoginStarted`, calls `ctx.ports.auth.login()` (→ `OAuthAuth`: opens the browser, catches the redirect, exchanges the code, looks up `/me`), emits `LoggedIn { player }`.
5. `EventSink::emit` reduces each event into `AppState` **and** broadcasts it.
6. `src-tauri` forwards the event as `app://event` to the frontend.
7. `ipc/client.ts` (`onEvent`) → `store.apply` → `store/reducer.ts` updates the slice.
8. `App.tsx` sees `auth.status === "loggedIn"` → renders `AppShell`.

Backend and frontend can never diverge because both **reduce the same event stream**.

---

## 6. "Where Do I Add X?" (Cookbook)

| I want to… | …then |
|---|---|
| **Add new state** | Slice in `faf-domain/src/state/<name>.rs` (state + events + commands + `reduce` + tests); wire into `state/mod.rs`, `events.rs`, `commands.rs`, `reducer.rs`. |
| **Add new backend capability** | Command + event(s) in the slice; service in `faf-app/src/services/<name>.rs`; dispatch arm in `runtime/mod.rs`. |
| **Add new external system** | `Port` trait in `faf-app/src/ports/`; impl in `infra/`; mock/fake for tests; field in `Ports`. |
| **Add new screen/tab** | Folder `ui/src/features/<name>/`; wire into `AppShell`; add `Tab` variant in `nav.rs` if needed. |
| **Add/change a theme** | Add a `[data-theme="…"]` block in `tokens.css` + a `Theme` variant in `faf-domain/state/settings.rs`. No component changes; never hardcode a color in a component (CI rejects hex outside `tokens.css`). |
| **Changed a cross-boundary type** | Run `npm run bindings` (otherwise the TS build breaks). |

**Never:** mutate state outside a reducer · do IO outside `infra/` · put logic in a component · write a cross-boundary type by hand.

---

## 7. Developing & Running

Prerequisites: Rust (stable), Node 20+, Tauri prereqs (Windows: WebView2 is already present).

```bash
npm install            # Frontend deps (once)
npm run bindings       # Regenerate ui/src/ipc/bindings.ts from Rust
npm run tauri dev      # Start the app (Vite + Tauri)

cargo test             # Rust tests (reducer + loop + services)
npm run typecheck      # tsc over the frontend
npm run build          # Build frontend to ui/dist
```

---

## 8. Current Status

- **Implemented:** session, auth, nav, lobby (4 slices), complete loop, type generation,
  multi-tab shell, CI + bindings-drift check.
- **Real auth:** `OAuthAuth` — FAF Ory Hydra, Authorization Code + PKCE. `FakeAuth` remains
  for tests and offline dev (`FAF_FAKE_AUTH=1`).
- **Real lobby:** `LobbyClient` — FAF lobby WebSocket protocol behind `LobbyPort`, with
  `connect`/`disconnect`. Opt-in via `FAF_REAL_LOBBY=1`; `FakeLobby` is the default. Live
  auth runs FAF's `faf-uid` executable (`FAF_UID_PATH`) for the anti-smurf fingerprint.
  Slices, services and UI did **not** change when the real client dropped in.
- **Phase plan & rationale:** see [`ARCHITECTURE.md`](ARCHITECTURE.md) §7.

Rule of thumb when extending: if something grows or gets unclear → split it. A new small slice/service is always better than a growing file.
