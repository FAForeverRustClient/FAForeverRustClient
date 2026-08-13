//! Business logic. One module per feature.
//!
//! A service consumes a command, performs side effects through [`crate::ports`],
//! and emits events via the [`EventSink`](crate::EventSink). A service **never**
//! touches `AppState` directly (ARCHITECTURE.md §3.4).

pub mod auth;
pub mod chat;
pub mod launcher;
pub mod leaderboard;
pub mod lobby;
pub mod maps;
pub mod mods;
pub mod nav;
pub mod replays;
pub mod session;
pub mod settings;
