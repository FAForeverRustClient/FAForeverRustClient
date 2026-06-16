# Forge Client

A modular FAF (Supreme Commander: Forged Alliance Forever) client in **Rust + Tauri**,
with a **React** frontend reusing the ForgeMapToolkit design system.

Architecture is the contract: see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
One source of truth in Rust, a fully state-driven UI, no per-tab logic.

## Status

The unidirectional state loop is wired end-to-end and proven:

```
UI dispatch ─▶ Tauri command ─▶ service ─▶ event ─▶ reduce(AppState) ─▶ emit ─▶ store ─▶ UI
```

Features so far:

- **session** — connection-status handshake.
- **auth** — login/logout via the **Port pattern** (`AuthPort`). Real provider `OAuthAuth`
  (FAF Ory Hydra, Authorization Code + PKCE); `FakeAuth` for tests/offline. State-driven
  login ↔ app routing.
- **nav** — multi-tab shell; the active tab lives in `AppState` so the backend can drive
  navigation too.
- **settings** — persisted preferences (first: UI `theme`), loaded from disk on startup
  and saved on change via `SettingsPort` → `FileSettings`. The theme is type-safe across
  the boundary (a `Theme` enum) and applied as `<html data-theme>`. Four themes ship:
  `forgeDark` (default), `forgeLight`, `javaClient`, `pythonClient` — each a token set in
  `tokens.css`, so adding a theme touches no component.
- **lobby** — a live open-games list driven by a **streaming port** (`LobbyPort::connect`
  → snapshot stream → `GamesUpdated` events), with explicit `connect`/`disconnect`.
  Real provider `LobbyClient` (FAF lobby WebSocket protocol) behind `FAF_REAL_LOBBY=1`,
  verified live against production; `FakeLobby` is the default. The connection flow is
  `GET user.faforever.com/lobby/access` → verified `wss://…/?verify=…` URL →
  `ask_session` → `auth` (token + `faf-uid` fingerprint) → `game_info`. The OAuth access
  token reaches the lobby via an in-memory `TokenStore`, never through `AppState`.

**CI** (`.github/workflows/ci.yml`) runs tests, clippy, typecheck, build, a
bindings-drift check (fails if `ui/src/ipc/bindings.ts` is stale), and a tokens-only
guardrail (fails if any component CSS hardcodes a hex color instead of a token).

Env toggles for local dev:
- `FAF_FAKE_AUTH=1` — skip the browser login (offline fake auth)
- `FAF_REAL_LOBBY=1` — use the real lobby WebSocket client instead of the fake
- `FAF_UID_PATH` — path to the `faf-uid` executable (<https://github.com/FAForever/uid/releases>)
- `FAF_CLIENT_VERSION` — client version reported to the lobby (defaults to the crate version)
- `FAF_USER_API_BASE` / `FAF_API_BASE` / `FAF_HYDRA_BASE` / `FAF_LOBBY_URL` — endpoint overrides (e.g. staging)

## Layout

```
crates/
  faf-domain/   pure state + events + commands + reducer (no IO, no async)
  faf-app/      runtime loop, services, ports, infra
  faf-ipc/      generates ui/src/ipc/bindings.ts from the Rust types
src-tauri/      thin Tauri shell (commands + event forwarding)
ui/             React frontend (ipc bridge, Zustand store, features)
docs/           ARCHITECTURE.md
```

## Develop

Prerequisites: Rust (stable), Node 20+, and the Tauri prerequisites for your OS
(on Windows: WebView2, already present on Win 10/11).

```bash
npm install                 # frontend deps
npm run bindings            # regenerate ui/src/ipc/bindings.ts from Rust
npm run tauri dev           # run the app (Vite + Tauri)
```

Other commands:

```bash
cargo test                  # run Rust tests (reducer + loop)
npm run typecheck           # tsc over the frontend
npm run build               # build the frontend to ui/dist
```

## Conventions

When you add anything, follow [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8:

- New state → a **slice** + reducer + tests in `faf-domain/state/`.
- New capability → a **command + event(s)** + a **service** in `faf-app/services/`.
- New external system → a **`Port` trait** + an **`infra` impl** + a mock.
- New screen → a **`features/<tab>/`** folder; container selects + dispatches, view uses primitives.
- After changing cross-boundary types, run `npm run bindings`.

Never: mutate state outside a reducer; do IO outside `infra`; put logic in a component;
hand-write a cross-boundary type.
