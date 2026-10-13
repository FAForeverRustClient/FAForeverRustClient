//! Settings slice: persisted user preferences.
//!
//! Preferences live in the backend-owned [`crate::state::AppState`] and are
//! projected by the UI. Grouping them by feature keeps the IPC contract stable
//! as the settings page grows. A UI section changes a group by sending a typed
//! patch of the fields it touched (see `preference_patch!`), never a whole
//! group copied out of its last snapshot, and never a stringly-typed key/value
//! pair.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

use crate::protocol::map_generator::GeneratorOptions;

use super::chat::normalize_channels;
use super::lobby::PlayerVeto;
use super::mods::ModPreset;
use super::replays::normalize_replay_path;
use super::Tab;

// The files reach these two as `super::lobby::HostGameConfig` and
// `super::ReleaseChannel`, paths written when `super` was the state module
// itself. Importing them here keeps those paths resolving unchanged.
use super::{lobby, ReleaseChannel};
// The same for two documentation links, `super::NotificationKind` and
// `super::chat::read_marker_key`. Only rustdoc reads them, and the comments
// they sit in are copied into the generated TypeScript, so the paths stay.
#[cfg(doc)]
use super::{chat::read_marker_key, NotificationKind};

// The machinery every group's `Patch` type is declared with. First, because a
// `macro_rules!` macro is only in scope in the modules declared after it.
#[macro_use]
mod patch;

use patch::{camel_case, patch_field};

// One file per preference group, re-exported flat so `state::settings::X` and
// `state::X` keep resolving: the split is for the reader, not for the paths.
// Each file starts with `use super::*`, which is how they see the imports and
// helpers here and one another.
mod appearance;
mod browsing;
mod chat;
mod connectivity;
mod entries;
mod events;
mod game;
mod game_browser;
mod general;
mod host_game;
mod integrations;
mod live_replays;
mod messages;
mod notifications;
mod reducer;
mod social;
mod state;

pub use appearance::*;
pub use browsing::*;
pub use chat::*;
pub use connectivity::*;
pub use entries::*;
pub use events::*;
pub use game::*;
pub use game_browser::*;
pub use general::*;
pub use host_game::*;
pub use integrations::*;
pub use live_replays::*;
pub use messages::*;
pub use notifications::*;
pub use reducer::*;
pub use social::*;
pub use state::*;

// Helpers more than one group reaches for.
fn default_true() -> bool {
    true
}

fn truncate_trimmed(value: String, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn normalize_logins(logins: Vec<String>, limit: usize) -> Vec<String> {
    let mut normalized = Vec::new();
    for login in logins {
        let login = login.trim();
        if login.is_empty() || login.len() > 64 {
            continue;
        }
        if !normalized
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(login))
        {
            normalized.push(login.to_owned());
        }
        if normalized.len() == limit {
            break;
        }
    }
    normalized.sort_by_key(|login| login.to_ascii_lowercase());
    normalized
}
