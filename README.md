# FAForever Client

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

- **session**: connection-status handshake.
- **auth**: login/logout via the **Port pattern** (`AuthPort`). Real provider `OAuthAuth`
  (FAF Ory Hydra, Authorization Code + PKCE); `FakeAuth` for tests/offline. State-driven
  login ↔ app routing. The login screen can remember the session using an OS-keyring
  refresh token and restore it silently on the next launch.
- **nav**: multi-tab shell; the active tab lives in `AppState` so the backend can drive
  navigation too.
- **settings**: persisted preferences (first: UI `theme`), loaded from disk on startup
  and saved on change via `SettingsPort` → `FileSettings`. The theme is type-safe across
  the boundary (a `Theme` enum) and applied as `<html data-theme>`. Four themes ship:
  `forgeDark` (default), `forgeLight`, `javaClient`, `pythonClient`: each a token set in
  `tokens.css`, so adding a theme touches no component.
- **lobby**: a live open-games list driven by a **streaming port** (`LobbyPort::connect`
  → snapshot stream → `GamesUpdated` events), with explicit `connect`/`disconnect`.
  Real provider `LobbyClient` (FAF lobby WebSocket protocol) is used for normal account
  sessions; `FakeLobby` remains available for offline mode. The connection flow is
  `GET user.faforever.com/lobby/access` → verified `wss://…/?verify=…` URL →
  `ask_session` → `auth` (token + `faf-uid` fingerprint) → `game_info`. The OAuth access
  token reaches the lobby via an in-memory `TokenStore`, never through `AppState`.

**CI** (`.github/workflows/ci.yml`) runs tests, clippy, frontend linting,
typecheck, build, a bindings-drift check (fails if `ui/src/ipc/bindings.ts` is
stale), and a tokens-only guardrail (fails if any component CSS hardcodes a
hex color instead of a token).

Env toggles for local dev:
- `FAF_FAKE_AUTH=1`: skip the browser login (offline fake auth)
- `FAF_FAKE_LOBBY=1` / `FAF_FAKE_CHAT=1`: keep either live service local while testing
- `FAF_REAL_LOBBY=1` / `FAF_REAL_CHAT=1`: legacy flags retained for existing launch scripts;
  live services are now the default for a real account session
- `FAF_ICE_ADAPTER_KIND`: overrides the Settings choice: `java` selects the
  production `faf-ice-adapter` (the default); `go` selects the experimental
  bundled `faf-pioneer` backend.
- `FAF_UID_PATH`: optional path override for the `faf-uid` executable. `pnpm run tauri …`
  prepares the official helper in `natives/` automatically (<https://github.com/FAForever/uid/releases>);
  `FAF_UID_VERSION` can select a different release.
- `FAF_ICE_ADAPTER_JAR`: override the checksum-verified Java ICE adapter bundled by `pnpm tauri`
- `FAF_JAVA_PATH`: override the Java 21+ executable. The client otherwise checks a bundled runtime, the official FAF Client installation, `JAVA_HOME`, then `PATH`.
- `FAF_ICE_ADAPTER_VERSION` and `FAF_ICE_ADAPTER_SHA256`: override the pinned official adapter release together
- `FAF_ICE_ADAPTER_PATH`: optional path override for the bundled `faf-pioneer`
- `FAF_GAME_PATH`: path to `ForgedAlliance.exe` (its folder must hold `init_<mod>.lua`)
- `FAF_CLIENT_VERSION`: client version reported to the lobby (defaults to the crate version)
- `FAF_LOG`: optional `tracing` filter for client diagnostics (for example
  `faf_app=debug,forge_client_lib=info,warn`); the default records client info and all warnings
- `FAF_USER_API_BASE` / `FAF_API_BASE` / `FAF_HYDRA_BASE` / `FAF_LOBBY_URL`: endpoint overrides (e.g. staging)

Packaged and development builds write daily `faforever-client.*.log` files to
the operating system's application log directory. At most seven files are
retained. Debug builds also mirror the structured log to the terminal; access
tokens, raw adapter output, local paths and network candidates are intentionally
excluded from these records.

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

Prerequisites: Rust (stable), Node 20+, pnpm (via `corepack enable pnpm`), and the
Tauri prerequisites for your OS (on Windows: WebView2, already present on Win 10/11).
Dependency installation with npm or Yarn is intentionally rejected; use the pnpm
version pinned by `package.json`.

```bash
pnpm install                # frontend deps
pnpm run bindings           # regenerate ui/src/ipc/bindings.ts from Rust
pnpm run tauri dev          # run the app (Vite + Tauri)
```

The Tauri command prepares the platform-specific `faf-uid` helper in the ignored
`natives/` directory. Set `FAF_SKIP_UID_DOWNLOAD=1` for an offline/test run, or
provide `FAF_UID_PATH` when using a locally managed binary.

Other commands:

```bash
cargo test                  # run Rust tests (reducer + loop)
pnpm run lint               # ESLint, including React Hooks rules
pnpm run typecheck          # tsc over the frontend
pnpm test                   # run frontend tests
pnpm run build              # build the frontend to ui/dist
```

## Conventions

When you add anything, follow [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8:

- New state → a **slice** + reducer + tests in `faf-domain/state/`.
- New capability → a **command + event(s)** + a **service** in `faf-app/services/`.
- New external system → a **`Port` trait** + an **`infra` impl** + a mock.
- New screen → a **`features/<tab>/`** folder; container selects + dispatches, view uses primitives.
- After changing cross-boundary types, run `pnpm run bindings`.

Never: mutate state outside a reducer; do IO outside `infra`; put logic in a component;
hand-write a cross-boundary type.
