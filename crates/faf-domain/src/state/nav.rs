//! Navigation slice: which top-level tab is active.
//!
//! Navigation lives in the single source of truth (not just the frontend) on
//! purpose: it lets **backend** events drive the view too: e.g. "you joined a
//! game → switch to the game tab", or restoring the last tab on reconnect.
//! Truly ephemeral widget state (hover, an open dropdown) stays in components.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A top-level destination. Most are placeholders today; each gets its feature
/// slice as it lands. The frontend tab registry maps these 1:1 to views.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Tab {
    #[default]
    News,
    Chat,
    Play,
    Replays,
    Maps,
    Mods,
    Leaderboard,
    Tournaments,
    Tutorials,
    Units,
    Changelog,
    Contribution,
    Settings,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NavState {
    pub active_tab: Tab,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum NavEvent {
    TabSelected { tab: Tab },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum NavCommand {
    Select { tab: Tab },
}

pub fn reduce(state: &mut NavState, event: &NavEvent) {
    match event {
        NavEvent::TabSelected { tab } => state.active_tab = *tab,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selecting_a_tab_makes_it_active() {
        let mut s = NavState::default();
        assert_eq!(s.active_tab, Tab::News);
        reduce(&mut s, &NavEvent::TabSelected { tab: Tab::Play });
        assert_eq!(s.active_tab, Tab::Play);
    }
}
