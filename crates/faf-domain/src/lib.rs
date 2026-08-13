//! Pure domain layer for the FAF client.
//!
//! This crate has **no IO and no async**. It defines:
//! - [`AppState`] and its slices ([`state`])
//! - the [`AppCommand`] and [`AppEvent`] enums
//! - the pure [`reduce`] function: the *only* place state ever changes.
//!
//! See `docs/ARCHITECTURE.md` §3 for the full contract.

pub mod commands;
pub mod events;
pub mod protocol;
pub mod reducer;
pub mod state;

pub use commands::AppCommand;
pub use events::AppEvent;
pub use reducer::reduce;
pub use state::AppState;
