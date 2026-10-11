//! Navigation slice: which top-level tab is active, and which section each
//! sectioned destination was last left on.
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
    /// The community calendar: what is happening in FAF, and when.
    Events,
    Training,
    Units,
    Changelog,
    /// The link directory: FAF's own sites and what the community built.
    ///
    /// Named for what it holds rather than for what it used to be. It grew out
    /// of the Contribution tab, whose repositories and credits are one section
    /// of it now.
    Links,
    Settings,
}

/// The section open inside Maps.
///
/// Every sectioned destination remembers its section here rather than in the
/// view, for the reason `PlayMode` does: the views unmount when their tab loses
/// focus, so a section held in component state went back to the first one on
/// every visit, and someone working through their installed maps was dropped
/// into the vault each time they glanced at chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MapsSection {
    #[default]
    Vault,
    Installed,
}

/// The section open inside Mods. See [`MapsSection`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ModsSection {
    #[default]
    Vault,
    Installed,
}

/// The replay source open inside Replays. See [`MapsSection`].
///
/// Online is the default because every "Replays" button elsewhere in the client
/// asks for a vault search, and the vault is what most visits are for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReplaysSection {
    Live,
    #[default]
    Online,
    Local,
}

/// The page open inside Settings. See [`MapsSection`].
///
/// The names are the frontend's section keys, in sidebar order, so the sidebar
/// can use this type as its key and a new section cannot be added on one side
/// only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SettingsSection {
    #[default]
    General,
    Appearance,
    Chat,
    Notifications,
    Account,
    Game,
    Paths,
    Cache,
    Connectivity,
    Diagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NavState {
    pub active_tab: Tab,
    /// Kept for the session only: a fresh start opens each destination on its
    /// first section, the same as `PlayMode`.
    pub maps_section: MapsSection,
    pub mods_section: ModsSection,
    pub replays_section: ReplaysSection,
    pub settings_section: SettingsSection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum NavEvent {
    TabSelected { tab: Tab },
    MapsSectionSelected { section: MapsSection },
    ModsSectionSelected { section: ModsSection },
    ReplaysSectionSelected { section: ReplaysSection },
    SettingsSectionSelected { section: SettingsSection },
}

/// One command per destination rather than one carrying a destination and a
/// section, so a section can never be sent to a destination that does not
/// have it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum NavCommand {
    Select { tab: Tab },
    SelectMapsSection { section: MapsSection },
    SelectModsSection { section: ModsSection },
    SelectReplaysSection { section: ReplaysSection },
    SelectSettingsSection { section: SettingsSection },
}

pub fn reduce(state: &mut NavState, event: &NavEvent) {
    match event {
        NavEvent::TabSelected { tab } => state.active_tab = *tab,
        NavEvent::MapsSectionSelected { section } => state.maps_section = *section,
        NavEvent::ModsSectionSelected { section } => state.mods_section = *section,
        NavEvent::ReplaysSectionSelected { section } => state.replays_section = *section,
        NavEvent::SettingsSectionSelected { section } => state.settings_section = *section,
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

    #[test]
    fn sections_open_on_their_first_page() {
        let s = NavState::default();
        assert_eq!(s.maps_section, MapsSection::Vault);
        assert_eq!(s.mods_section, ModsSection::Vault);
        assert_eq!(s.replays_section, ReplaysSection::Online);
        assert_eq!(s.settings_section, SettingsSection::General);
    }

    #[test]
    fn a_section_survives_leaving_its_tab_and_coming_back() {
        let mut s = NavState::default();
        reduce(&mut s, &NavEvent::TabSelected { tab: Tab::Maps });
        reduce(
            &mut s,
            &NavEvent::MapsSectionSelected {
                section: MapsSection::Installed,
            },
        );
        reduce(&mut s, &NavEvent::TabSelected { tab: Tab::Chat });
        reduce(&mut s, &NavEvent::TabSelected { tab: Tab::Maps });
        assert_eq!(s.maps_section, MapsSection::Installed);
    }

    #[test]
    fn each_destination_keeps_its_own_section() {
        let mut s = NavState::default();
        reduce(
            &mut s,
            &NavEvent::ModsSectionSelected {
                section: ModsSection::Installed,
            },
        );
        reduce(
            &mut s,
            &NavEvent::ReplaysSectionSelected {
                section: ReplaysSection::Local,
            },
        );
        reduce(
            &mut s,
            &NavEvent::SettingsSectionSelected {
                section: SettingsSection::Cache,
            },
        );
        assert_eq!(s.maps_section, MapsSection::Vault);
        assert_eq!(s.mods_section, ModsSection::Installed);
        assert_eq!(s.replays_section, ReplaysSection::Local);
        assert_eq!(s.settings_section, SettingsSection::Cache);
        assert_eq!(s.active_tab, Tab::News);
    }
}
