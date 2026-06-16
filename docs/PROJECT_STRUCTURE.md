# Project Structure

This document provides an overview of the `rust-client` repository layout.

```
rust-client/
├── crates/                     # Shared internal Rust crates (workspace members)
│
├── docs/                       # Project documentation
│
├── src-tauri/                  # Tauri backend (Rust)
│   └── ...                     # Tauri config, Rust source, build scripts
│
├── ui/                         # Frontend (TypeScript / framework of choice)
│   ├── dist/                   # Compiled frontend output (generated, not committed)
│   └── src/
│       ├── design-system/      # Reusable UI components & design tokens
│       ├── features/           # Feature-based modules
│       │   ├── auth/           # Authentication flow
│       │   ├── home/           # Home / dashboard view
│       │   ├── lobby/          # Lobby feature
│       │   ├── nav/            # Navigation / routing
│       │   ├── shell/          # App shell / layout wrapper
│       │   └── status/         # Status display
│       ├── ipc/                # IPC bindings – typed bridge to Tauri commands
│       └── store/              # Global state management
│
├── target/                     # Rust build artifacts (generated, not committed)
├── node_modules/               # JS dependencies (generated, not committed)
│
├── Cargo.toml                  # Rust workspace manifest
├── Cargo.lock                  # Locked dependency versions
├── package.json                # JS package manifest
└── ...
```

## Directory Breakdown

### `crates/`
Internal Rust library crates shared across the workspace. Splitting logic into dedicated crates keeps compilation units small and enforces clear API boundaries.

### `docs/`
Hand-written documentation – architecture decisions, setup guides, API references, etc.

### `src-tauri/`
The Tauri application backend written in Rust. Contains:
- `tauri.conf.json` – window, bundle, and permission configuration
- `src/` – Rust source (commands, event handlers, state)
- `build.rs` – build script

### `ui/`
The web-based frontend rendered inside the Tauri webview.

| Sub-directory | Purpose |
|---|---|
| `design-system/` | Shared components, tokens, and theming primitives |
| `features/` | Self-contained feature modules (auth, home, lobby, …) |
| `ipc/` | Typed wrappers around `invoke()` calls to Tauri commands |
| `store/` | Application-wide reactive state |

### Generated / ignored directories
The following directories are produced by the build toolchain and are excluded from version control via `.gitignore`:

| Directory | Produced by |
|---|---|
| `target/` | `cargo build` |
| `node_modules/` | `npm install` / `yarn` |
| `ui/dist/` | frontend bundler |
